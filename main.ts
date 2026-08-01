import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip-js/zip-js";

const autoPublish = Deno.env.get('AUTO_MR_PUBLISH') === '1';
const modrinthToken = Deno.env.get('MODRINTH_TOKEN');

const defaultBaseProjectId = Deno.env.get('BASE_MODPACK_PROJECT_ID') ?? '1KVo5zza';
const defaultBaseVersionId = Deno.env.get('BASE_MODPACK_VERSION_ID');

const autoGithubRelease = Deno.env.get('AUTO_GITHUB_RELEASE') === '1';
const githubToken = Deno.env.get('GITHUB_TOKEN');
const githubRepository = Deno.env.get('GITHUB_REPOSITORY');

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

interface BranchFile {
	path: string
	content: string
	mode?: 'override' | 'replace'
	target?: string
}

interface BranchConfig {
	name: string
	base?: { projectId?: string, versionId?: string }
	projects: Array<{ id: string, meta?: unknown }>
	files: Array<BranchFile>
	remove?: Array<string>
}

interface RemoteBaseConfig {
	projectId: string
	versionId?: string
}

interface BaseResult {
	indexFile: IndexFile
	dir: string
	gameVersion: string
	versionNumber: string
}

interface BuildResult extends BaseResult {
	mrpackData: Uint8Array
}

const remoteBaseCache = new Map<string, { data: Version[], indexFile: IndexFile, dir: string }>();

async function getRemoteBase(config: RemoteBaseConfig): Promise<{ data: Version[], indexFile: IndexFile, dir: string }> {
	const cacheKey = `${config.projectId}@${config.versionId ?? 'latest'}`;
	const cached = remoteBaseCache.get(cacheKey);
	if (cached) return cached;

	console.log(`Fetching base modpack ${config.projectId}${config.versionId ? ` (version ${config.versionId})` : ' (latest)'}`);

	let data: Version[];
	if (config.versionId) {
		const version: Version = await (await fetch(`https://api.modrinth.com/v2/version/${config.versionId}`)).json();
		data = [version];
	} else {
		data = await (await fetch(`https://api.modrinth.com/v2/project/${config.projectId}/version`)).json();
	}

	if (!data || data.length === 0) {
		throw new Error(`No versions found for base modpack ${config.projectId}${config.versionId ? ` (version ${config.versionId})` : ''}`);
	}

	console.log(`Found base version download URL: ${data[0].files[0].url}`);

	const safeKey = cacheKey.replace(/[^a-zA-Z0-9_.-]/g, '_');
	const archivePath = `.base-downloads/${safeKey}.mrpack`;
	const dir = `.base-cache/${safeKey}`;

	console.log('Begin download');
	await Deno.mkdir('.base-downloads', { recursive: true });
	await Deno.writeFile(archivePath, new Uint8Array(await (await fetch(data[0].files[0].url)).arrayBuffer()));
	console.log('Download complete');

	console.log('Begin extraction');
	await unzip(archivePath, dir);
	console.log('Extraction complete');

	await Deno.remove(archivePath);

	const indexFile: IndexFile = JSON.parse(new TextDecoder().decode(await Deno.readFile(`${dir}/modrinth.index.json`)));

	const result = { data, indexFile, dir };
	remoteBaseCache.set(cacheKey, result);
	return result;
}

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

async function removeBaseContent(
	branchLabel: string,
	processingDir: string,
	branchIndexFile: IndexFile,
	remove: Array<string>,
) {
	if (!remove || remove.length === 0) return;

	const directoryPatterns = new Set<string>();
	const removeSet = new Set<string>();

	for (const entry of remove) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (trimmed.endsWith('/')) {
			directoryPatterns.add(trimmed.replace(/\/+$/, ''));
		} else {
			removeSet.add(trimmed);
		}
	}

	for (const identifier of [...removeSet]) {
		if (identifier.includes('.') || identifier.includes('/')) continue;
		try {
			const versions: Version[] = await (await fetch(`https://api.modrinth.com/v2/project/${identifier}/version`)).json();
			for (const version of versions) {
				for (const file of version.files) {
					removeSet.add(file.filename);
				}
			}
		} catch {
			console.warn(`[${branchLabel}] Could not resolve "${identifier}" as a Modrinth project ID for removal`);
		}
	}

	for (const dir of directoryPatterns) {
		let removedAny = false;
		for (const candidate of [
			`${processingDir}/overrides/${dir}`,
			`${processingDir}/${dir}`,
		]) {
			try {
				await Deno.remove(candidate, { recursive: true });
				console.log(`[${branchLabel}] Removed directory ${dir} (${candidate})`);
				removedAny = true;
			} catch {
				continue;
			}
		}
		if (!removedAny) {
			console.warn(`[${branchLabel}] Directory removal "${dir}/" did not match anything on disk`);
		}
	}

	const keptFiles: IndexFile['files'] = [];
	for (const file of branchIndexFile.files) {
		const basename = file.path.split('/').pop() ?? file.path;
		const inRemovedDirectory = [...directoryPatterns].some((dir) => file.path === dir || file.path.startsWith(`${dir}/`));
		const shouldRemove = removeSet.has(file.path) || removeSet.has(basename) || inRemovedDirectory;
		if (shouldRemove) {
			console.log(`[${branchLabel}] Removing base content: ${file.path}`);
			for (const candidate of [
				`${processingDir}/overrides/${file.path}`,
				`${processingDir}/${file.path}`,
			]) {
				try {
					await Deno.remove(candidate);
				} catch {
					continue;
				}
			}
		} else {
			keptFiles.push(file);
		}
	}
	branchIndexFile.files = keptFiles;
}

async function applyBranchFile(filename: string, file: BranchFile): Promise<void> {
	const mode = file.mode ?? 'override';
	const overridesPath = `.processing/${filename}/overrides/${file.path}`;

	if (mode === 'override') {
		await Deno.writeFile(overridesPath, new TextEncoder().encode(file.content));
		return;
	}

	if (mode === 'replace') {
		if (!file.target) {
			console.warn(`[${filename}] File ${file.path} has mode "replace" but no target, skipping`);
			return;
		}

		const candidates = [overridesPath, `.processing/${filename}/${file.path}`];
		let existingPath: string | null = null;
		let existing = '';
		for (const candidate of candidates) {
			try {
				existing = new TextDecoder().decode(await Deno.readFile(candidate));
				existingPath = candidate;
				break;
			} catch {
				continue;
			}
		}

		if (existingPath === null) {
			console.warn(`[${filename}] File ${file.path} has mode "replace" but no existing file was found to modify, skipping`);
			return;
		}

		const regex = new RegExp(file.target, 'g');
		const matches = [...existing.matchAll(regex)];

		if (matches.length === 0) {
			console.warn(`[${filename}] File ${file.path} has mode "replace" but target ${JSON.stringify(file.target)} did not match anything in ${existingPath} - file left unchanged`);
			return;
		}

		let updated = existing;
		let replacedAny = false;
		for (const match of matches.reverse()) {
			const groups = match.slice(1).filter((g): g is string => typeof g === 'string' && g.length > 0);
			if (groups.length === 0) continue;
			let piece = match[0];
			for (const group of groups) {
				piece = piece.replace(group, file.content);
			}
			const matchStart = match.index!;
			updated = updated.slice(0, matchStart) + piece + updated.slice(matchStart + match[0].length);
			replacedAny = true;
		}

		if (!replacedAny) {
			console.warn(`[${filename}] File ${file.path} has mode "replace" but target ${JSON.stringify(file.target)} matched with no capturing groups in ${existingPath} - file left unchanged`);
			return;
		}

		await Deno.writeFile(existingPath, new TextEncoder().encode(updated));
		return;
	}

	console.warn(`[${filename}] Unknown file mode "${mode}" for ${file.path}, skipping`);
}

interface ProjectInfo {
	id: string
	project_type: string
	loaders: Array<string>
}

async function getProjectInfo(projectId: string): Promise<ProjectInfo> {
	const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}`);
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

interface ProjectTypeInfo {
	directory: string
	env: { client: string, server: string }
}

const projectTypeInfo: Record<string, ProjectTypeInfo> = {
	mod: { directory: 'mods', env: { client: 'required', server: 'required' } },
	resourcepack: { directory: 'resourcepacks', env: { client: 'required', server: 'unsupported' } },
	shader: { directory: 'shaderpacks', env: { client: 'required', server: 'unsupported' } },
	datapack: { directory: 'datapacks', env: { client: 'unsupported', server: 'required' } },
	plugin: { directory: 'plugins', env: { client: 'unsupported', server: 'required' } },
};

function getProjectTypeInfo(projectType: string | undefined): ProjectTypeInfo {
	return projectTypeInfo[projectType ?? 'mod'] ?? projectTypeInfo.mod;
}

async function readBranchConfig(filename: string): Promise<BranchConfig> {
	return JSON.parse(new TextDecoder().decode(await Deno.readFile(`mods/${filename}`)));
}

async function findBranchFile(identifier: string): Promise<string> {
	for await (const entry of Deno.readDir(Deno.cwd() + '/mods')) {
		if (!entry.isFile) continue;
		const stem = entry.name.includes('.') ? entry.name.slice(0, entry.name.lastIndexOf('.')) : entry.name;
		if (entry.name === identifier || stem === identifier) return entry.name;
	}
	for await (const entry of Deno.readDir(Deno.cwd() + '/mods')) {
		if (!entry.isFile) continue;
		try {
			const config = await readBranchConfig(entry.name);
			if (config.name === identifier) return entry.name;
		} catch {
			continue;
		}
	}
	throw new Error(`Could not find a branch matching "build:${identifier}" to use as a base`);
}

const builtBranches = new Map<string, BuildResult>();
const buildingStack: Array<string> = [];

let trackedVersionOverride: Version | null = null;

async function buildBranch(filename: string): Promise<BuildResult> {
	const cached = builtBranches.get(filename);
	if (cached) return cached;

	if (buildingStack.includes(filename)) {
		throw new Error(`Circular "build:" dependency detected: ${[...buildingStack, filename].join(' -> ')}`);
	}
	buildingStack.push(filename);

	console.log(`Creating working directory for ${filename}`);

	const branch = await readBranchConfig(filename);

	const requestedProjectId = branch.base?.projectId ?? defaultBaseProjectId;
	let requestedVersionId = branch.base?.versionId ?? defaultBaseVersionId;
	if (!branch.base?.versionId && requestedProjectId === defaultBaseProjectId && trackedVersionOverride) {
		requestedVersionId = trackedVersionOverride.id;
	}

	let base: BaseResult;
	if (requestedProjectId.startsWith('build:')) {
		const targetIdentifier = requestedProjectId.slice('build:'.length);
		const targetFilename = await findBranchFile(targetIdentifier);
		console.log(`[${filename}] Base depends on branch "${targetIdentifier}" (${targetFilename}) - resolving`);
		base = await buildBranch(targetFilename);
	} else {
		const remote = await getRemoteBase({ projectId: requestedProjectId, versionId: requestedVersionId });
		base = {
			indexFile: remote.indexFile,
			dir: remote.dir,
			gameVersion: remote.data[0].game_versions[0],
			versionNumber: remote.data[0].version_number,
		};
	}

	await Deno.mkdir(`./.processing/${filename}`, { recursive: true });
	console.log(`[${filename}] Working directory created`);
	await copyDir(base.dir, `./.processing/${filename}`);
	console.log(`[${filename}] Base files copied (from ${requestedProjectId})`);

	const branchIndexFile: IndexFile = JSON.parse(JSON.stringify(base.indexFile));
	branchIndexFile.name = branch.name;

	if (branch.remove && branch.remove.length > 0) {
		await removeBaseContent(filename, `.processing/${filename}`, branchIndexFile, branch.remove);
	}

	for (const project of branch.projects) {
		console.log(`[${filename}] Requesting data for ${project.id}`);

		let info: ProjectInfo | null = null;
		try {
			info = await getProjectInfo(project.id);
		} catch (err) {
			console.warn(`[${filename}] Could not fetch project info for ${project.id} (${(err as Error).message}) - assuming it's a fabric mod`);
		}

		const typeInfo = getProjectTypeInfo(info?.project_type);
		const targetLoaders = info?.loaders && info.loaders.length > 0 ? info.loaders : ['fabric'];
		const targetGameVersions = [base.gameVersion];

		const versionQuery = new URLSearchParams();
		versionQuery.set('loaders', JSON.stringify(targetLoaders));
		versionQuery.set('game_versions', JSON.stringify(targetGameVersions));
		const versions: Version[] = await (await fetch(`https://api.modrinth.com/v2/project/${project.id}/version?${versionQuery.toString()}`)).json();

		if (versions.length === 0) {
			let availableInfo = 'could not fetch project versions to check';
			try {
				const allVersions: Version[] = await (await fetch(`https://api.modrinth.com/v2/project/${project.id}/version`)).json();
				const availableGameVersions = new Set<string>();
				const availableLoaders = new Set<string>();
				for (const v of allVersions) {
					for (const gv of v.game_versions) availableGameVersions.add(gv);
					for (const l of v.loaders) availableLoaders.add(l);
				}
				availableInfo = `game_versions=[${[...availableGameVersions].join(', ')}], loaders=[${[...availableLoaders].join(', ')}]`;
			} catch {
				// ignore
			}
			console.warn(`[${filename}] No versions found for ${project.id} (target game_versions=[${targetGameVersions.join(', ')}], loaders=[${targetLoaders.join(', ')}]) - available: ${availableInfo}, skipping`);
			continue;
		}
		console.log(`[${filename}] Found ${versions.length} versions for ${project.id} - latest is ${versions[0].id}`);
		branchIndexFile.files.push({
			path: `${typeInfo.directory}/${versions[0].files[0].filename}`,
			hashes: {
				sha1: versions[0].files[0].hashes.sha1,
				sha512: versions[0].files[0].hashes.sha512
			},
			env: typeInfo.env,
			downloads: [versions[0].files[0].url],
			fileSize: versions[0].files[0].size
		});
	}

	for (const file of branch.files) {
		await applyBranchFile(filename, file);
	}

	if (!(await Deno.stat(`src/${filename}`).catch(() => null))?.isDirectory) await Deno.mkdir(`src/${filename}`, { recursive: true });
	await Deno.writeFile(`.processing/${filename}/modrinth.index.json`, new TextEncoder().encode(JSON.stringify(branchIndexFile, null, 4)));
	console.log(`[${filename}] Updated index file written`);
	console.log(`[${filename}] Branch processing complete`);
	await copyDir(`.processing/${filename}`, `src/${filename}`);
	console.log(`[${filename}] Files written to src/${filename}`);
	await Deno.remove(`./.processing/${filename}`, { recursive: true });
	console.log(`[${filename}] Working directory cleaned up`);

	if (!(await Deno.stat(`dist/`).catch(() => null))?.isDirectory) await Deno.mkdir(`dist/`, { recursive: true });
	const zipWriter = new ZipWriter(new Uint8ArrayWriter());
	await addDirToZip(zipWriter, `src/${filename}`, "");
	const mrpackData = await zipWriter.close();
	await Deno.writeFile(`dist/${filename}.mrpack`, mrpackData);
	console.log(`[${filename}] Branch zipped to dist/${filename}.mrpack`);

	const versionNumber = `${base.versionNumber}+${filename}`;

	if (autoPublish) {
		if (!modrinthToken) {
			console.error(`[${filename}] AUTO_MR_PUBLISH=1 but MODRINTH_TOKEN is not set, skipping publish`);
		} else {
			const projectId = projectsMap.get(filename);
			if (!projectId) {
				console.warn(`[${filename}] No project ID found in projects.map, skipping publish`);
			} else {
				console.log(`[${filename}] Publishing to Modrinth project ${projectId}`);
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
				form.append('file', new Blob([mrpackData], { type: 'application/zip' }), `${filename}.mrpack`);
				const res = await fetch('https://api.modrinth.com/v2/version', {
					method: 'POST',
					headers: { Authorization: modrinthToken },
					body: form,
				});
				if (res.ok) {
					console.log(`[${filename}] Published ${versionNumber} to Modrinth`);
				} else {
					const body = await res.text();
					console.error(`[${filename}] Modrinth publish failed (${res.status}): ${body}`);
				}
			}
		}
	}

	const result: BuildResult = {
		indexFile: branchIndexFile,
		dir: `src/${filename}`,
		mrpackData,
		gameVersion: branchIndexFile.dependencies.minecraft,
		versionNumber,
	};
	builtBranches.set(filename, result);
	buildingStack.pop();
	return result;
}

async function runBuildPass(): Promise<void> {
	builtBranches.clear();
	buildingStack.length = 0;
	for await (const entry of Deno.readDir(Deno.cwd() + '/mods')) {
		if (!entry.isFile) continue;
		await buildBranch(entry.name);
	}
}

async function collectDistFiles(): Promise<Array<string>> {
	const files: Array<string> = [];
	try {
		for await (const entry of Deno.readDir('dist')) {
			if (entry.isFile && entry.name.endsWith('.mrpack')) files.push(`dist/${entry.name}`);
		}
	} catch {
		return files;
	}
	return files;
}

async function cleanBuildState(): Promise<void> {
	await Deno.remove('src', { recursive: true }).catch(() => {});
	await Deno.remove('dist', { recursive: true }).catch(() => {});
	await Deno.remove('.processing', { recursive: true }).catch(() => {});
}

async function githubRequest(path: string, init: RequestInit = {}): Promise<Response> {
	if (!githubToken || !githubRepository) {
		throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required for GitHub release tracking');
	}
	return fetch(`https://api.github.com/repos/${githubRepository}${path}`, {
		...init,
		headers: {
			'Authorization': `Bearer ${githubToken}`,
			'Accept': 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...(init.headers ?? {}),
		},
	});
}

async function getExistingReleaseTags(): Promise<Set<string>> {
	const tags = new Set<string>();
	let page = 1;
	while (true) {
		const res = await githubRequest(`/releases?per_page=100&page=${page}`);
		if (!res.ok) throw new Error(`Failed to fetch releases (page ${page}): ${res.status} ${await res.text()}`);
		const releases: Array<{ tag_name: string }> = await res.json();
		if (releases.length === 0) break;
		for (const r of releases) tags.add(r.tag_name);
		if (releases.length < 100) break;
		page++;
	}
	return tags;
}

async function createRelease(tag: string, name: string, body: string): Promise<{ id: number, upload_url: string }> {
	const res = await githubRequest('/releases', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }),
	});
	if (!res.ok) throw new Error(`Failed to create release ${tag}: ${res.status} ${await res.text()}`);
	return res.json();
}

async function uploadReleaseAsset(uploadUrlTemplate: string, filePath: string): Promise<void> {
	const name = filePath.split('/').pop()!;
	const uploadUrl = uploadUrlTemplate.replace('{?name,label}', `?name=${encodeURIComponent(name)}`);
	const data = await Deno.readFile(filePath);
	const res = await fetch(uploadUrl, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${githubToken}`,
			'Content-Type': 'application/octet-stream',
			'Accept': 'application/vnd.github+json',
		},
		body: data,
	});
	if (!res.ok) throw new Error(`Failed to upload asset ${name}: ${res.status} ${await res.text()}`);
}

async function getMissingBaseVersions(): Promise<Array<Version>> {
	const [allVersions, existingTags] = await Promise.all([
		(await fetch(`https://api.modrinth.com/v2/project/${defaultBaseProjectId}/version`)).json() as Promise<Array<Version>>,
		getExistingReleaseTags(),
	]);
	const sorted = [...allVersions].sort((a, b) => new Date(a.date_published).getTime() - new Date(b.date_published).getTime());

	const missing: Array<Version> = [];
	for (const version of sorted) {
		const tag = `v${version.version_number}`;
		if (existingTags.has(tag)) {
			console.log(`Release ${tag} already exists - skipping`);
			continue;
		}
		missing.push(version);
	}
	return missing;
}

if (autoGithubRelease) {
	console.log(`Checking ${defaultBaseProjectId} for versions missing a GitHub release`);
	const missingVersions = await getMissingBaseVersions();
	if (missingVersions.length === 0) {
		console.log('No missing versions - nothing to build');
	}
	for (const version of missingVersions) {
		const tag = `v${version.version_number}`;
		console.log(`Building release ${tag} (base modpack version ${version.id})`);

		await cleanBuildState();
		trackedVersionOverride = version;
		await runBuildPass();
		trackedVersionOverride = null;

		const distFiles = await collectDistFiles();
		if (distFiles.length === 0) {
			console.warn(`[${tag}] No .mrpack files were produced, skipping release creation`);
			continue;
		}

		console.log(`[${tag}] Creating GitHub release with ${distFiles.length} asset(s)`);
		const release = await createRelease(tag, tag, `Automated release for base modpack version ${version.version_number}.`);
		for (const file of distFiles) {
			await uploadReleaseAsset(release.upload_url, file);
		}
		console.log(`[${tag}] Release published`);
	}
	await cleanBuildState();
} else {
	await runBuildPass();
}

console.log('All branches processed');
console.log('Cleaning up base directories');
await Deno.remove('.base-cache', { recursive: true }).catch(() => {});
await Deno.remove('.base-downloads', { recursive: true }).catch(() => {});
console.log('Base directories cleaned up');
await Deno.remove('.processing', { recursive: true }).catch(() => {});
console.log('Processing directory cleaned up');