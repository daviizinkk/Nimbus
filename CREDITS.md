# Credits

Nimbus is built and maintained by:

- **Davi — [@SimplyDaviiz](https://github.com/SimplyDaviiz)** — creator, product design,
  implementation and release maintenance.
- **OpenCode AI** — development assistant for implementation, testing, documentation and
  release polish.

## Built with

Nimbus stands on the work of these open-source projects:

- [React](https://react.dev/) and [Vite](https://vite.dev/) for the web interface.
- [Fastify](https://fastify.dev/) and Node's built-in `node:sqlite` for the API and database.
- [Electron](https://www.electronjs.org/) for the Windows desktop shell.
- [Sharp](https://sharp.pixelplumbing.com/) for image previews and artwork generation.
- [Lucide](https://lucide.dev/) for interface icons.
- [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) for Discord Rich Presence.
- [Undici](https://undici.nodejs.org/) for provider HTTP requests.

## Artwork

The Nimbus cloud mark, Windows icon and release banner are generated from the vector sources
in [`public/favicon.svg`](public/favicon.svg) and
[`public/nimbus-banner.svg`](public/nimbus-banner.svg). Run `npm run desktop:icon` to rebuild
the standard icon sizes and banner resolutions in `build/`.

## Third-party services

Nimbus is not affiliated with Discord, GitHub, WebDAV vendors or any cloud storage provider.
Discord Rich Presence uses the local Discord client and a public Discord Application ID.
