# OpenCode Guidelines

## Commands
- Build/Run: `npm run start` or `bun run start`
- Format: `npm run format` or `bun run format`
- Export: `npm run export` or `bun run export`

## Code Style
- Use TypeScript with strict type checking
- Follow Effect.js patterns for functional programming
- Use snake_case for file names, camelCase for variables/functions
- Use PascalCase for classes, interfaces, and types
- Use enum for constants with PascalCase
- Prefer explicit typing over inference where clarity is needed
- Use Effect.Service for service definitions
- Use Effect.gen for generator-based effects

## Imports
- Group imports: external libraries first, then internal modules
- Sort imports alphabetically within groups
- Use absolute imports with '~/' prefix for project paths

## Error Handling
- Use Effect for error handling instead of try/catch
- Create custom error classes extending Data.TaggedError
- Provide descriptive error messages

## Formatting
- Use Prettier with @cvr/config/prettier configuration
- 2 space indentation
- Single quotes for strings
- Trailing commas in multi-line objects/arrays