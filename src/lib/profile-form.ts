// The logic behind the profile form: validating the input and writing the changed fields.
// It has no framework or network code of its own, so it can be unit-tested; the Server Action
// (app/profile/actions.ts) supplies the real writers.

export const NAME_MAX_LENGTH = 50;
// Matches the Go API: at most 1000 characters (code points), no NUL byte.
export const BIO_MAX_LENGTH = 1000;

export type FieldName = "name" | "bio";
export type FieldErrors = Partial<Record<FieldName, string>>;

export type ProfileInput = {
  name: string;
  /** null when the form did not offer the bio field (the Go API was unreachable on render). */
  bio: string | null;
};

type ParseResult = { ok: true; value: ProfileInput } | { ok: false; errors: FieldErrors };

// Browsers submit a textarea's line breaks as CRLF; we count and store one character per break.
export const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, "\n");

// Counts code points, like Go's utf8.RuneCountInString, so both sides agree on "1000 characters".
const length = (s: string) => [...s].length;

/** Validates the raw form values. `raw` comes from FormData, so nothing about it is trusted. */
export function parseProfileInput(raw: { name: unknown; bio: unknown }): ParseResult {
  const errors: FieldErrors = {};

  let name = "";
  if (typeof raw.name !== "string") {
    errors.name = "Enter a name.";
  } else {
    name = raw.name.trim();
    if (name === "") errors.name = "Enter a name.";
    else if (length(name) > NAME_MAX_LENGTH) {
      errors.name = `Use ${NAME_MAX_LENGTH} characters or fewer.`;
    } else if (name.includes("\0")) errors.name = "The name contains an invalid character.";
  }

  let bio: string | null = null;
  if (raw.bio !== null && raw.bio !== undefined) {
    if (typeof raw.bio !== "string") {
      errors.bio = "The bio is invalid.";
    } else {
      bio = normalizeNewlines(raw.bio);
      if (length(bio) > BIO_MAX_LENGTH) errors.bio = `Use ${BIO_MAX_LENGTH} characters or fewer.`;
      else if (bio.includes("\0")) errors.bio = "The bio contains an invalid character.";
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, bio } };
}

export type FieldResult = "unchanged" | "saved" | "failed";
export type SaveResult = Record<FieldName, FieldResult>;

export type ProfileWriters = {
  /** The name saved today (from the session). */
  currentName: string;
  /** The bio the form was showing, or null if it was not shown. */
  initialBio: string | null;
  updateName: (name: string) => Promise<void>;
  updateBio: (bio: string) => Promise<void>;
};

async function write(changed: boolean, run: () => Promise<void>): Promise<FieldResult> {
  if (!changed) return "unchanged";
  try {
    await run();
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * Writes only the fields that changed. The name (our database) and the bio (the Go API) live in
 * different stores, so there is no shared transaction: each write runs on its own and the
 * outcome is reported per field. Both writes are idempotent, so resubmitting is always safe.
 * Writers report failure by throwing; log it there, because only the outcome comes back here.
 */
export async function saveProfile(
  input: ProfileInput,
  writers: ProfileWriters,
): Promise<SaveResult> {
  const { bio } = input;
  // bio is null when the form did not show the field; then there is nothing to write.
  const bioWrite =
    bio !== null && bio !== writers.initialBio
      ? write(true, () => writers.updateBio(bio))
      : Promise.resolve<FieldResult>("unchanged");
  const [name, savedBio] = await Promise.all([
    write(input.name !== writers.currentName, () => writers.updateName(input.name)),
    bioWrite,
  ]);
  return { name, bio: savedBio };
}

/**
 * Where to go after a save: back to the profile page when nothing failed (everything saved, or
 * there was nothing to change); stay on the edit page when any field failed, so the user sees
 * which one and can resubmit.
 */
export function shouldLeaveEditPage(result: SaveResult): boolean {
  return result.name !== "failed" && result.bio !== "failed";
}

/** What the form shows after a submit. */
export type ProfileFormState = {
  /** The values that were submitted, so the form keeps them instead of resetting to the old ones. */
  values?: { name: string; bio: string | null };
  errors: FieldErrors;
  saved: Record<FieldName, boolean>;
};

/**
 * What the user typed, as the form should show it again after a rejected submit (a validation
 * error or too many requests). React resets uncontrolled fields after an action, so without this
 * a long bio that was one character too long would be replaced by the old text. Nothing is
 * trimmed or cut here; a field that was not in the form (bio, when the API was down) stays null.
 */
export function submittedValues(raw: { name: unknown; bio: unknown }): { name: string; bio: string | null } {
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    bio: typeof raw.bio === "string" ? normalizeNewlines(raw.bio) : null,
  };
}

export const initialProfileFormState: ProfileFormState = {
  errors: {},
  saved: { name: false, bio: false },
};

const FAILURE_MESSAGE: Record<FieldName, string> = {
  name: "Could not save your name. Please try again.",
  bio: "Could not save your bio. Please try again.",
};

export function toFormState(input: ProfileInput, result: SaveResult): ProfileFormState {
  const errors: FieldErrors = {};
  for (const field of ["name", "bio"] as const) {
    if (result[field] === "failed") errors[field] = FAILURE_MESSAGE[field];
  }
  return {
    values: input,
    errors,
    saved: { name: result.name === "saved", bio: result.bio === "saved" },
  };
}
