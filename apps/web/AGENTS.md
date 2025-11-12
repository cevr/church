# Agent Guidelines for bible-tools

## Build Commands
- `bun run dev` - Start development server with HMR
- `bun run build` - Create production build
- `bun run start` - Start production server
- `bun run typecheck` - Run TypeScript type checking and generate types

## Code Style Guidelines

### Imports & Path Aliases
- Use `~/` prefix for app imports (configured in tsconfig.json)
- Import order: React, external libraries, internal modules, relative imports
- Use `cn()` utility from `~/lib/utils` for conditional class names

### Component Patterns
- Use shadcn/ui components with Base UI primitives
- Follow class-variance-authority (CVA) patterns for component variants
- Use TypeScript interfaces for props extending React.ComponentProps
- Export component and variants separately

### TypeScript
- Strict mode enabled
- Use `type` imports for type-only imports
- Prefer interfaces over types for object shapes
- Use proper typing for React Router route types (auto-generated in .react-router/types/)

### Styling
- Use Tailwind CSS with CSS variables
- Follow shadcn/ui "new-york" style variant
- Use semantic color tokens (primary, secondary, destructive, etc.)
- Components should be responsive and accessible

### File Structure
- Components in `~/components/`, UI components in `~/components/ui/`
- Utilities in `~/lib/`
- Hooks in `~/hooks/`
- Routes in `~/routes/` with proper type exports