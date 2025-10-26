import Bun from 'bun';
import { Data, Effect } from 'effect';

// --- Helper Function: Execute AppleScript Command ---
const execCommand = Effect.fn('execCommand')(function* (command: string[]) {
  const result = yield* Effect.try(() => {
    const child = Bun.spawn(command);
    return child;
  });

  return yield* Effect.tryPromise(async () => {
    const text = await new Response(result.stdout).text();
    const errorText = await new Response(result.stderr).text();
    if (errorText) {
      throw new Error(`AppleScript Error: ${errorText}`);
    }
    return text.trim(); // Trim whitespace/newlines from output
  });
});

// --- Types ---
export interface NoteListItem {
  id: string;
  name: string;
  creationDate: string; // Dates are returned as strings by AppleScript
  modificationDate: string;
}

class NoteOperationError extends Data.TaggedError('NoteOperationError')<{
  message: string;
  cause?: unknown;
  script?: string;
  scriptOutput?: string;
}> {}

// --- Utility Functions ---

/**
 * Lists all notes in the default Notes account.
 * @returns An Effect that resolves with an array of NoteListItem objects.
 * @throws NoteOperationError if the AppleScript execution or parsing fails.
 */
export const listNotes = Effect.fn('listNotes')(function* () {
  yield* Effect.log('🔄 Fetching list of notes...');
  const script = `
    set noteList to {}
    tell application "Notes"
      set allNotes to every note
      set noteCount to count of allNotes -- Get total count
      set counter to 0
      repeat with i from 1 to noteCount
        if counter is 20 then exit repeat -- Stop after 20
        set aNote to item i of allNotes

        set noteId to id of aNote
        set noteName to name of aNote
        set noteCreationDate to creation date of aNote as string
        set noteModificationDate to modification date of aNote as string
        set end of noteList to {noteId:noteId, noteName:noteName, creationDate:noteCreationDate, modificationDate:noteModificationDate}
        set counter to counter + 1 -- Increment counter
      end repeat
    end tell

    -- Format the output as a simple, parseable string (e.g., ID|Name|Created|Modified newline)
    set output to ""
    repeat with noteProps in noteList
      set output to output & noteProps's noteId & "|" & noteProps's noteName & "|" & noteProps's creationDate & "|" & noteProps's modificationDate & "\n"
    end repeat
    return output
  `;

  const rawOutput = yield* execCommand(['osascript', '-e', script]).pipe(
    Effect.catchAll(
      (error) =>
        new NoteOperationError({
          message: 'Failed to execute listNotes AppleScript',
          cause: error,
          script,
        }),
    ),
  );

  yield* Effect.log('📊 Parsing note list...');
  const notes: NoteListItem[] = rawOutput
    .split('\n') // Split into lines, one per note
    .filter((line) => line.trim() !== '') // Remove empty lines
    .map((line) => {
      const parts = line.split('|'); // Split by the delimiter
      if (parts.length !== 4) {
        // Handle potential parsing errors or unexpected format
        console.warn(`Skipping malformed line: ${line}`);
        return null;
      }
      return {
        id: parts[0],
        name: parts[1], // Names might contain special characters, handled by script?
        creationDate: parts[2],
        modificationDate: parts[3],
      };
    })
    .filter((note): note is NoteListItem => note !== null); // Filter out nulls from malformed lines

  yield* Effect.log(`✅ Found ${notes.length} notes.`);
  return notes;
});

/**
 * Retrieves the HTML body content of a specific note.
 * @param noteId The ID of the note to retrieve.
 * @returns An Effect that resolves with the HTML string content of the note.
 * @throws NoteOperationError if the note is not found or the script fails.
 */
export const getNoteContent = Effect.fn('getNoteContent')(function* (
  noteId: string,
) {
  yield* Effect.log(`🔄 Fetching content for note ID: ${noteId}...`);
  const script = `
    tell application "Notes"
      try
        get body of note id "${noteId}"
      on error errMsg number errNum
        return "Error: Note not found or access denied. " & errMsg & " (" & errNum & ")"
      end try
    end tell
  `;

  const content = yield* execCommand(['osascript', '-e', script]).pipe(
    Effect.catchAll(
      (error) =>
        new NoteOperationError({
          message: `Failed to execute getNoteContent AppleScript for ID ${noteId}`,
          cause: error,
          script,
        }),
    ),
  );

  // Check if AppleScript returned an error message
  if (content.startsWith('Error:')) {
    return yield* Effect.fail(
      new NoteOperationError({
        message: `Failed to get content for note ID ${noteId}: ${content}`,
        script,
        scriptOutput: content,
      }),
    );
  }

  yield* Effect.log(`✅ Content fetched for note ID: ${noteId}.`);
  return content;
});

/**
 * Updates the body content of a specific note.
 * @param noteId The ID of the note to update.
 * @param newContent The new HTML content for the note body.
 * @returns An Effect that resolves when the update is complete.
 * @throws NoteOperationError if the note is not found or the script fails.
 */
export const updateNoteContent = Effect.fn('updateNoteContent')(function* (
  noteId: string,
  newContent: string,
) {
  yield* Effect.log(`🔄 Updating content for note ID: ${noteId}...`);

  const script = `
    tell application "Notes"
      try
        set theNote to note id "${noteId}"
        set body of theNote to "${newContent}"
        return "Success"
      on error errMsg number errNum
        return "Error: Note not found or update failed. " & errMsg & " (" & errNum & ")"
      end try
    end tell
  `;

  const result = yield* execCommand(['osascript', '-e', script]).pipe(
    Effect.catchAll(
      (error) =>
        new NoteOperationError({
          message: `Failed to execute updateNoteContent AppleScript for ID ${noteId}`,
          cause: error,
          script,
        }),
    ),
  );

  if (!result.startsWith('Success')) {
    return yield* Effect.fail(
      new NoteOperationError({
        message: `Failed to update content for note ID ${noteId}: ${result}`,
        script,
        scriptOutput: result,
      }),
    );
  }

  yield* Effect.log(`✅ Content updated for note ID: ${noteId}.`);
});

/**
 * Deletes a specific note.
 * @param noteId The ID of the note to delete.
 * @returns An Effect that resolves when the deletion is complete.
 * @throws NoteOperationError if the note is not found or the script fails.
 */
export const deleteNote = Effect.fn('deleteNote')(function* (noteId: string) {
  yield* Effect.log(`🔄 Deleting note ID: ${noteId}...`);
  const script = `
    tell application "Notes"
      try
        delete note id "${noteId}"
        return "Success"
      on error errMsg number errNum
         return "Error: Note not found or deletion failed. " & errMsg & " (" & errNum & ")"
      end try
    end tell
  `;

  const result = yield* execCommand(['osascript', '-e', script]).pipe(
    Effect.catchAll(
      (error) =>
        new NoteOperationError({
          message: `Failed to execute deleteNote AppleScript for ID ${noteId}`,
          cause: error,
          script,
        }),
    ),
  );

  if (!result.startsWith('Success')) {
    return yield* Effect.fail(
      new NoteOperationError({
        message: `Failed to delete note ID ${noteId}: ${result}`,
        script,
        scriptOutput: result,
      }),
    );
  }

  yield* Effect.log(`✅ Note deleted: ${noteId}.`);
});

/**
 * Creates a new note with the given title and plain text body.
 * Note: Apple Notes uses HTML for its body. This function uses the provided text
 * directly, which Notes might interpret as plain text within its HTML structure.
 * For rich formatting, use the `makeAppleNoteFromMarkdown` utility or ensure the `body`
 * contains valid HTML.
 *
 * @param title The title for the new note.
 * @param body The plain text or HTML content for the note body.
 * @returns An Effect that resolves with the ID of the newly created note.
 * @throws NoteOperationError if the creation fails.
 */
export const createNote = Effect.fn('createNote')(function* (
  title: string,
  body: string,
) {
  yield* Effect.log(`🔄 Creating new note titled: "${title}"...`);

  const script = `
    tell application "Notes"
      try
        set theNote to make new note with properties {name:"${title}", body:"${body}"}
        return id of theNote
      on error errMsg number errNum
        return "Error: Note creation failed. " & errMsg & " (" & errNum & ")"
      end try
    end tell
  `;

  const newNoteId = yield* execCommand(['osascript', '-e', script]).pipe(
    Effect.catchAll(
      (error) =>
        new NoteOperationError({
          message: 'Failed to execute createNote AppleScript',
          cause: error,
          script,
        }),
    ),
  );

  // Basic check if the output looks like a note ID (contains hyphens) or an error
  if (newNoteId.startsWith('Error:') || !newNoteId.includes('-')) {
    return yield* Effect.fail(
      new NoteOperationError({
        message: `Failed to create note "${title}": ${newNoteId}`,
        script,
        scriptOutput: newNoteId,
      }),
    );
  }

  yield* Effect.log(`✅ Note created with ID: ${newNoteId}.`);
  return newNoteId;
});
