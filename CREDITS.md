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

The Nimbus cloud mark comes from the 1.2.0 Liquid Glass masters in
[`build/updated_v1_2_0_icon_blue.png`](build/updated_v1_2_0_icon_blue.png) (primary) and
[`build/updated_v1_2_0_icon_white.png`](build/updated_v1_2_0_icon_white.png) (alternate).
The release banner layout lives in [`public/nimbus-banner.svg`](public/nimbus-banner.svg)
and is composited with the primary mark. Run `npm run desktop:icon` to rebuild the Windows
icon, tray glyph, favicon and banner resolutions in `build/` and `public/nimbus-icon.png`.

## Third-party services

Nimbus is not affiliated with Discord, GitHub, WebDAV vendors or any cloud storage provider.
Discord Rich Presence uses the local Discord client and a public Discord Application ID.
