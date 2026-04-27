<script lang="ts">
    import Monaco from "svelte-monaco";

    interface Version {
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

    type Project = {
        client_side: string
        server_side: string
        game_versions: Array<string>
        id: string
        slug: string
        project_type: string
        team: string
        organization: string | null
        title: string
        description: string
        body: string
        body_url?: any
        published: string
        updated: string
        approved: string
        queued: any
        status: string
        requested_status: any
        moderator_message: any
        license: {
            id: string
            name: string
            url: string | null
        }
        downloads: number
        followers: number
        categories: Array<string>
        additional_categories: Array<any>
        loaders: Array<string>
        versions: Array<string>
        icon_url: string
        issues_url: string | null
        source_url: string | null
        wiki_url: string | null
        discord_url: string | null
        donation_urls: Array<{
            id: string
            platform: string
            url: string
        }>
        gallery: Array<{
            url: string
            raw_url: string
            featured: boolean
            title: string
            description: string
            created: string
            ordering: number
        }>
        color: number
        thread_id: string
        monetization_status: string
    }

    async function fetchProject(identifier: string) {
        const response = await fetch(`https://api.modrinth.com/v2/project/${identifier}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            }
        });
        const versionsResponse = await fetch(`https://api.modrinth.com/v2/project/${identifier}/version`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch project ${identifier}: ${response.statusText}`);
            return;
        }

        const projectData = await response.json();
        const versionData: Array<Version> = await versionsResponse.json();

        if (!fetchedProjects.some(p => p.id === projectData.id)) {
            fetchedProjects.push(projectData);
            data.projects.push({ id: projectData.id });
        }

        versionData.forEach(v => {
            if (!fetchedVersions.some(ver => ver.id === v.id)) {
                fetchedVersions.push(v);
            }
        });

        if (projectData.project_type === 'modpack') {
            versionData.filter(v => v.game_versions.includes(basePack.game_version)).forEach((version) => {
                version.dependencies.forEach(dependency => {
                    if (dependency.dependency_type === 'embedded') {
                        console.log(`Project ${projectData.title} has embedded dependency ${dependency.project_id}`);
                        fetchProject(dependency.project_id!);
                    }
                });
            });
        }

        console.log(`Fetched project ${projectData.title} with ${versionData.length} versions.`);
    }

    let basePack = $state({
        id: '1KVo5zza',
        game_version: '26.1.2'
    });
    let fetchedProjects: Array<Project> = [];
    let fetchedVersions: Array<Version> = [];
    let data: { name: string, projects: Array<{ id: string }> } = $state({ name: "Simple Server Set - Base", projects: [] });
    let json: string = $derived(JSON.stringify(data, null, 4));
    let currentAddingProjectId: string = $state('');
</script>

<div class="base">
    <input type="text" placeholder="Base ID or Slug" bind:value={basePack.id} />
    <input type="text" placeholder="Game Version" bind:value={basePack.game_version} />
    <button onclick={() => fetchProject(basePack.id)}>Load Base</button>
</div>
<div class="split">
    <div class="editor">
        <div class="toolbar">
            <input type="text" placeholder="Project ID or Slug" bind:value={currentAddingProjectId} />
            <button onclick={() => {fetchProject(currentAddingProjectId); currentAddingProjectId = ''}}>Add Project</button>
        </div>
        <div class="project-list">
            {#key data.projects.length}
            {#each data.projects.map(p => ({ ...p, ...fetchedProjects.find(fp => fp.id === p.id) })) as project}
                <div class="project-item">
                    <div>
                        <h3>{project.title}</h3>
                        <p>{project.description}</p>
                        <div class="actions">
                            <button onclick={() => {
                                data.projects = data.projects.filter(p => p.id !== project.id);
                            }}>Remove</button>
                        </div>
                    </div>
                    <div>
                        <img src={project.icon_url} alt={`${project.title} icon`} width="100" height="100" />
                    </div>
                </div>
            {/each}
            {/key}
        </div>
    </div>
    <div class="code">
        <Monaco
            options={{ language: 'json', automaticLayout: true, readOnly: true, readOnlyMessage: { value: 'Please just use the editor on the left.' }, lineNumbers: 'on' }}
            theme="vs-dark"
            on:ready={(event) => console.log(event.detail)}
            bind:value={json}
        />
    </div>
</div>

<style>
    :global(body) {
        margin: 0;
        padding: 0;
        font-family: sans-serif;
        background-color: #282c34;
    }

    .split {
        display: flex;
        height: 100vh;
    }

    .base {
        background-color: #32363d;
        padding: 5vh;
    }

    .editor, .code {
        flex: 1;
    }

    .code {
        background-color: #1e2127;

        padding: 1rem;
        border-radius: 1rem;
    }

    .project-list {
        padding: 1rem;
    }

    .project-item {
        background-color: #3a3f4b;
        color: whitesmoke;
        margin-bottom: 1rem;
        padding: 1rem;
        border-radius: 0.5rem;

        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    button {
        background-color: #61dafb;
        border: none;
        padding: 0.5rem 1rem;
        border-radius: 0.25rem;
        cursor: pointer;
    }

    input {
        padding: 0.5rem;
        border-radius: 0.25rem;
        border: none;
        margin-right: 0.5rem;
    }

    .toolbar {
        padding: 1rem;
        background-color: #2c313c;
        display: flex;
        align-items: center;
    }
</style>