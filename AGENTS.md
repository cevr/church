## Build, Lint, and Test Commands

- **Run**: `bun run start`
- **Format**: `bun run format`
- **Test**: No test command found.

## Code Style Guidelines

### Imports

- Use `import { ... } from '...'` syntax.
- Order: external libraries, then local imports.

### Formatting

- This project uses Prettier for code formatting. Run `bun run format` before
  committing.

### Types

- This is a TypeScript project. Add types to all variables, functions, and
  classes.
- The project uses `effect-ts` for functional programming and type-safe error
  handling.

### Naming Conventions

- **Classes and Enums**: `PascalCase`
- **Variables and Functions**: `camelCase`

### Error Handling

- Use the `effect-ts` library for error handling.
- Use `Effect.gen` for complex effects.
- Use `Effect.tryPromise` to wrap promises.

### Key Libraries

- **`effect-ts`**: This is the core library for this project. Understand its
  basic concepts before making changes.
- **`@clack/prompts`**: Used for command-line prompts.
