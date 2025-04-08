import { marked } from "marked";
import { exec } from "child_process";
import { Effect, Data, pipe, Option, Schema } from "effect";

// --- Helper Function: Escape string for AppleScript ---
function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// --- Helper Function: Extract Title from Markdown ---
// Tries to find the first H1 heading
function extractTitleFromMarkdown(
  markdownContent: string
): Option.Option<string> {
  const h1Match = markdownContent.match(/^\s*#\s+(.*?)(\s+#*)?$/m); // Match lines starting with # (H1)
  return Option.fromNullable(h1Match?.[1]?.trim());
}

class ExecError extends Data.TaggedError("ExecError")<{
  message: string;
  stderr?: string;
}> {}

class MarkdownParseError extends Data.TaggedError("MarkdownParseError")<{
  message: string;
  cause: unknown;
  content: string;
}> {}

/**
 * Options for creating the Apple Note.
 */
export interface CreateSimpleNoteOptions {
  /** Override the title automatically extracted from Markdown H1. Defaults to 'Untitled Note' if no H1 found. */
  title?: string;
  /** Set to true to bring the Notes application to the foreground after creation. Defaults to false. */
  activateNotesApp?: boolean;
}

const execCommand = Effect.fn("execCommand")(function* (command: string) {
  const result = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        const child = exec(command);
        return new Promise<{
          stdout: string;
          stderr: string;
          child: ReturnType<typeof exec>;
        }>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) {
              resolve({
                stdout: child.stdout?.toString() || "",
                stderr: child.stderr?.toString() || "",
                child,
              });
            } else {
              reject(new Error(`Process exited with code ${code}`));
            }
          });
        });
      },
      catch: (cause: unknown) =>
        new ExecError({
          message: `Failed to execute command: ${cause}`,
        }),
    }),
    (result) =>
      Effect.sync(() => {
        result.child.kill();
      })
  ).pipe(Effect.scoped);

  return result;
});

const parseMarkdown = Effect.fn("parseMarkdown")(function* (content: string) {
  const result = yield* Effect.try({
    try: () => marked.parse(content),
    catch: (cause: unknown) =>
      new MarkdownParseError({
        message: `Markdown parsing failed`,
        cause,
        content,
      }),
  }).pipe(Effect.flatMap(Schema.decodeUnknown(Schema.String)));

  return result;
});

/**
 * Converts Markdown content to HTML and creates a new note in the default
 * account and folder of Apple Notes.
 * Requires macOS and potentially Automation permissions for Notes.
 *
 * @param markdownContent The raw Markdown string to convert.
 * @param options Optional configuration for the note title and activation behavior.
 * @returns An Effect that resolves with the final title used for the note upon successful creation.
 * @throws An error if the AppleScript execution fails (e.g., permissions issues).
 */
export const makeAppleNoteFromMarkdown = Effect.fn("makeAppleNoteFromMarkdown")(
  function* (markdownContent: string, options: CreateSimpleNoteOptions = {}) {
    yield* Effect.logDebug("🔄 Converting Markdown to HTML...");

    // Determine the note title
    const finalNoteTitle =
      options.title ??
      pipe(
        extractTitleFromMarkdown(markdownContent),
        Option.getOrElse(() => "Untitled Note")
      );
    yield* Effect.logDebug(`ℹ️  Using note title: "${finalNoteTitle}"`);

    // Remove the H1 heading from content if we're using it as the title
    const contentToParse = options.title
      ? markdownContent
      : markdownContent.replace(/^\s*#\s+.*?(\s+#*)?$/m, "").trim();

    // Add extra line breaks between sections
    const contentWithBreaks = contentToParse
      .replace(/(?=#{2,4}\s)/g, "\n\n\n") // Add breaks before h2-h4
      .replace(/(?<=#{2,4}.*\n)/g, "\n\n"); // Add breaks after h2-h4

    const htmlContent = yield* parseMarkdown(contentWithBreaks);

    // Prepare HTML for AppleScript (basic structure and styling)
    const styledHtmlContent = `
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 24px;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px;
          }
          h1 {
            font-size: 36px;
            margin-bottom: 48px;
            padding-bottom: 20px;
            border-bottom: 2px solid #e9ecef;
          }
          h2 {
            font-size: 32px;
            margin-top: 64px;
            margin-bottom: 40px;
            padding-bottom: 16px;
            border-bottom: 1px solid #e9ecef;
          }
          h3 {
            font-size: 30px;
            margin-top: 56px;
            margin-bottom: 32px;
          }
          h4 {
            font-size: 28px;
            margin-top: 48px;
            margin-bottom: 28px;
          }
          p {
            font-size: 24px;
            margin-bottom: 32px;
            line-height: 1.7;
          }
          pre {
            background-color: #f8f9fa;
            padding: 28px;
            border-radius: 8px;
            overflow-x: auto;
            font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
            white-space: pre;
            font-size: 22px;
            line-height: 1.6;
            margin: 40px 0;
            border: 1px solid #e9ecef;
          }
          code {
            font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
            font-size: 22px;
            background-color: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid #e9ecef;
          }
          ul, ol {
            font-size: 24px;
            margin: 40px 0;
            padding-left: 40px;
          }
          li {
            margin-bottom: 24px;
            line-height: 1.7;
          }
          blockquote {
            font-size: 24px;
            border-left: 4px solid #e9ecef;
            margin: 48px 0;
            padding: 24px 32px;
            background-color: #f8f9fa;
            border-radius: 0 8px 8px 0;
          }
          hr {
            border: none;
            border-top: 2px solid #e9ecef;
            margin: 64px 0;
          }
          img {
            max-width: 100%;
            height: auto;
            margin: 40px 0;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin: 40px 0;
          }
          th, td {
            padding: 16px;
            border: 1px solid #e9ecef;
            text-align: left;
          }
          th {
            background-color: #f8f9fa;
            font-weight: 600;
          }
          tr:nth-child(even) {
            background-color: #f8f9fa;
          }
        </style>
      </head>
      <body>
        ${htmlContent}
      </body>
      </html>
    `;

    // Escape content for AppleScript embedding
    const escapedHtmlBody = escapeAppleScriptString(styledHtmlContent);
    const escapedNoteTitle = escapeAppleScriptString(finalNoteTitle);

    // Construct the AppleScript command (always targets the main Notes application)
    yield* Effect.logDebug(
      "🔨 Constructing AppleScript command for default location..."
    );
    const scriptTarget = 'application "Notes"'; // Simplified target
    const activateCommand = options.activateNotesApp ? "activate" : "";

    const appleScriptCommand = `
      tell ${scriptTarget}
        make new note with properties {name:"${escapedNoteTitle}", body:"${escapedHtmlBody}"}
        ${activateCommand}
      end tell
    `;

    // Execute the AppleScript
    yield* Effect.logDebug(
      "🚀 Executing AppleScript to create note in default location..."
    );
    yield* execCommand(`osascript -e '${appleScriptCommand}'`);

    // Success
    yield* Effect.logDebug(
      `✅ Success! Note "${finalNoteTitle}" created in Apple Notes (default location).`
    );
    return finalNoteTitle; // Resolve with the title used
  }
);
