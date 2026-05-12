# pi-2048

2048 as a pi extension.

This extension adds the `/play-2048` command and opens the game in a same-window overlay inside pi.

## Files

- `index.ts` — extension entrypoint
- `package.json` — pi package manifest
- `tsconfig.json` — optional local type-checking config

## Usage

### Install from GitHub

```bash
pi install https://github.com/brendengourley/pi-2048
```

## Command

- `/play-2048` — open the game overlay

## State

The game state is persisted at:

```text
~/.pi/agent/state/2048-save.json
```

## Development

Optional, for editor/type-checking support:

```bash
cd ~/Documents/pi-2048
npm install
npm run check
```
