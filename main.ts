import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip-js/zip-js";

const autoPublish = Deno.env.get('AUTO_MR_PUBLISH') === '1';
const modrinthToken = Deno.env.get('MODRINTH_TOKEN');

const projectsMap = new Map<string, string>();
try {
	const mapLines = new TextDecoder().decode(await Deno.readFile('projects.map')).split('\n');
	for (const line of mapLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [branch, projectId] = trimmed.split(':');
		if (branch && projectId) projectsMap.set(branch.trim(), projectId.trim());
	}
} catch {
	console.warn('Could not read projects.map - Modrinth publishing will be skipped');
}

async function unzip(filePath: string, destPath: string) {
	const zipReader = new ZipReader(new Uint8ArrayReader(await Deno.readFile(filePath)));
	const entries = await zipReader.getEntries();

	for (const entry of entries) {
		if (entry.directory) continue;
		const content = await entry.getData?.(new Uint8ArrayWriter());
		if (!content) continue;
		const outPath = destPath + "/" + entry.filename;
		const outDir = outPath.substring(0, outPath.lastIndexOf("/"));
		if (outDir) await Deno.mkdir(outDir, { recursive: true });
		await Deno.writeFile(outPath, content);
	}
	await zipReader.close();
}

export interface Version {
	game_versions: Array<string>
	loaders: Array<string>
	id: string
	project_id: string
	author_id: string
	featured: boolean
	name: string
	version_number: string
	changelog: string
	changelog_url?: string
	date_published: string
	downloads: number
	version_type: string
	status: string
	requested_status?: string
	files: Array<{
		id: string
		hashes: {
			sha1: string
			sha512: string
		}
		url: string
		filename: string
		primary: boolean
		size: number
		file_type?: string
	}>
	dependencies: Array<{
		version_id?: string
		project_id?: string
		file_name?: string
		dependency_type: string
	}>
}

const data: Version[] = await (await fetch('https://api.modrinth.com/v2/project/1KVo5zza/version')).json();

console.log(`Found latest version download URL: ${data[0].files[0].url}`);

console.log('Begin download');
await Deno.writeFile('FO.mrpack', new Uint8Array(await (await fetch(data[0].files[0].url)).arrayBuffer()));
console.log('Download complete')

console.log('Begin extraction');
await unzip('FO.mrpack', '.base');
console.log('Extraction complete');

console.log('Cleaning up');
await Deno.remove('FO.mrpack');
console.log('Passing to branches');

async function copyDir(src: string, dest: string) {
	for await (const entry of Deno.readDir(src)) {
		const srcPath = src + "/" + entry.name;
		const destPath = dest + "/" + entry.name;
		if (entry.isDirectory) {
			await Deno.mkdir(destPath, { recursive: true });
			await copyDir(srcPath, destPath);
		} else if (entry.isFile) {
			await Deno.copyFile(srcPath, destPath);
		}
	}
}

interface IndexFile {
	formatVersion: number
	game: string
	versionId: string
	name: string
	files: Array<{
		path: string
		hashes: {
			sha1: string
			sha512: string
		}
		env: {
			client: string
			server: string
		}
		downloads: Array<string>
		fileSize: number
	}>
	dependencies: {
		"fabric-loader": string
		minecraft: string
	}
}

const baseIndexFile: IndexFile = JSON.parse(new TextDecoder().decode(await Deno.readFile('.base/modrinth.index.json')));

async function addDirToZip(zipWriter: ZipWriter<Uint8Array>, dir: string, prefix: string) {
	for await (const e of Deno.readDir(dir)) {
		const srcPath = dir + "/" + e.name;
		const entryPath = prefix ? prefix + "/" + e.name : e.name;
		if (e.isDirectory) {
			await addDirToZip(zipWriter, srcPath, entryPath);
		} else if (e.isFile) {
			await zipWriter.add(entryPath, new Uint8ArrayReader(await Deno.readFile(srcPath)));
		}
	}
}

for await (const entry of Deno.readDir(Deno.cwd() + '/mods')) {
	if (!entry.isFile) continue;

	console.log(`Creating working directory for ${entry.name}`);
	await Deno.mkdir(`./.processing/${entry.name}`, { recursive: true });
	console.log(`[${entry.name}] Working directory created`);

	await copyDir('./.base', `./.processing/${entry.name}`);
	console.log(`[${entry.name}] Base files copied`);

	const branch: { name: string, projects: Array<{ id: string }>, files: Array<{ path: string, content: string }> } = JSON.parse(new TextDecoder().decode(await Deno.readFile(`mods/${entry.name}`)));

	const branchIndexFile: IndexFile = JSON.parse(JSON.stringify(baseIndexFile));
	branchIndexFile.name = branch.name;

	for (const project of branch.projects) {
		console.log(`[${entry.name}] Requesting data for ${project.id}`);
		const versions: Version[] = await (await fetch(`https://api.modrinth.com/v2/project/${project.id}/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(`["${data[0].game_versions[0]}"]`)}`)).json();

		if (versions.length === 0) {
			console.warn(`[${entry.name}] No versions found for ${project.id}, skipping`);
			continue;
		}

		console.log(`[${entry.name}] Found ${versions.length} versions for ${project.id} - latest is ${versions[0].id}`);

		branchIndexFile.files.push({
			path: `mods/${versions[0].files[0].filename}`,
			hashes: {
				sha1: versions[0].files[0].hashes.sha1,
				sha512: versions[0].files[0].hashes.sha512
			},
			env: {
				client: "required",
				server: "required"
			},
			downloads: [versions[0].files[0].url],
			fileSize: versions[0].files[0].size
		});
	}

	for (const file of branch.files) {
		const filePath = `.processing/${entry.name}/overrides/${file.path}`;
		await Deno.writeFile(filePath, new TextEncoder().encode(file.content));
	}

	if (!(await Deno.stat(`src/${entry.name}`).catch(() => null))?.isDirectory) await Deno.mkdir(`src/${entry.name}`, { recursive: true });
	await Deno.writeFile(`.processing/${entry.name}/modrinth.index.json`, new TextEncoder().encode(JSON.stringify(branchIndexFile, null, 4)));
	console.log(`[${entry.name}] Updated index file written`);
	console.log(`[${entry.name}] Branch processing complete`);
	await copyDir(`.processing/${entry.name}`, `src/${entry.name}`);
	console.log(`[${entry.name}] Files written to src/${entry.name}`);
	await Deno.remove(`./.processing/${entry.name}`, { recursive: true });
	console.log(`[${entry.name}] Working directory cleaned up`);

	if (!(await Deno.stat(`dist/`).catch(() => null))?.isDirectory) await Deno.mkdir(`dist/`, { recursive: true });

	const zipWriter = new ZipWriter(new Uint8ArrayWriter());
	await addDirToZip(zipWriter, `src/${entry.name}`, "");
	const mrpackData = await zipWriter.close();
	await Deno.writeFile(`dist/${entry.name}.mrpack`, mrpackData);
	console.log(`[${entry.name}] Branch zipped to dist/${entry.name}.mrpack`);

	if (!autoPublish) continue;
	if (!modrinthToken) {
		console.error(`[${entry.name}] AUTO_MR_PUBLISH=1 but MODRINTH_TOKEN is not set, skipping publish`);
		continue;
	}
	const projectId = projectsMap.get(entry.name);
	if (!projectId) {
		console.warn(`[${entry.name}] No project ID found in projects.map, skipping publish`);
		continue;
	}
	console.log(`[${entry.name}] Publishing to Modrinth project ${projectId}`);
	const versionNumber = `${data[0].version_number}+${entry.name}`;
	const versionData = {
		name: versionNumber,
		version_number: versionNumber,
		dependencies: [],
		game_versions: [branchIndexFile.dependencies.minecraft],
		version_type: 'release',
		loaders: ['fabric'],
		featured: false,
		project_id: projectId,
		file_parts: ['file'],
	};
	const form = new FormData();
	form.append('data', JSON.stringify(versionData));
	form.append('file', new Blob([mrpackData], { type: 'application/zip' }), `${entry.name}.mrpack`);
	const res = await fetch('https://api.modrinth.com/v2/version', {
		method: 'POST',
		headers: { Authorization: modrinthToken },
		body: form,
	});
	if (res.ok) {
		console.log(`[${entry.name}] Published ${versionNumber} to Modrinth`);
		continue;
	}
	const body = await res.text();
	console.error(`[${entry.name}] Modrinth publish failed (${res.status}): ${body}`);
}

console.log('All branches processed');
console.log('Cleaning up base directory');
await Deno.remove('.base', { recursive: true });
console.log('Base directory cleaned up');
await Deno.remove('.processing', { recursive: true });
console.log('Processing directory cleaned up');