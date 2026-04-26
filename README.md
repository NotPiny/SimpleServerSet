<img alt="fabulously-optimized" height="56" src="https://cdn.jsdelivr.net/npm/@intergrav/devins-badges@3/assets/cozy/built-with/fabulously-optimized_vector.svg">

# Simple Server Set
A simple modpack built for general use, built on top of the [Fabulously Optimized](https://modrive.com/modpacks/fabulously-optimized) modpack. It can also be a base for your own modpack, as the build process is very easy to set up and use.

## Building
To build the modpack, you need to have [Deno](https://deno.com) installed. Then, just run the following command in the root of the project:

```bash
deno run --allow-read --allow-write --allow-net main.ts
```

This will create a `dist` folder with the built modpack. You can then upload this folder to your server or share it with others. You can also look into the files in the `src` folder to see how the outputted modpack is structured.

## License
This project is licensed under the [OQL v1.4](https://oql.avris.it/license/v1.4?c[1]=piny|https://piny.dev) license. Fabulously Optimized, on which this project is based, is licensed under [BSD-3-Clause](https://raw.githubusercontent.com/Fabulously-Optimized/fabulously-optimized/refs/heads/main/LICENSE.md).