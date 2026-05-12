# pi-2048

2048 as a pi extension.

This extension adds the `/play-2048` command and opens the game in a same-window overlay inside pi.

## Files

- `index.ts` — extension entrypoint
- `package.json` — pi package manifest
- `tsconfig.json` — optional local type-checking config

## Usage

### One-off run

```bash
pi -e ~/Documents/pi-2048
```

### Install as a local package

```bash
pi install ~/Documents/pi-2048
```

### Add as a local extension path in settings

Add this directory to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/brenden.gourley/Documents/pi-2048"
  ]
}
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
