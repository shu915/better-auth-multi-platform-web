import { describe, expect, it, vi } from "vitest";
import {
  BIO_MAX_LENGTH,
  NAME_MAX_LENGTH,
  parseProfileInput,
  saveProfile,
  shouldLeaveEditPage,
  toFormState,
  type ProfileWriters,
} from "@/lib/profile-form";

describe("parseProfileInput", () => {
  it("trims the name and accepts a valid pair", () => {
    expect(parseProfileInput({ name: "  Ada  ", bio: "hi" })).toEqual({
      ok: true,
      value: { name: "Ada", bio: "hi" },
    });
  });

  it("allows an empty bio, which clears it", () => {
    expect(parseProfileInput({ name: "Ada", bio: "" })).toEqual({
      ok: true,
      value: { name: "Ada", bio: "" },
    });
  });

  it("treats a missing bio field as 'not offered', not as an empty bio", () => {
    expect(parseProfileInput({ name: "Ada", bio: null })).toEqual({
      ok: true,
      value: { name: "Ada", bio: null },
    });
  });

  it.each<[unknown, string]>([
    ["", "empty"],
    ["   ", "blank"],
    [null, "missing"],
    [42, "not a string"],
  ])(
    "rejects a name that is %j (%s)",
    (name) => {
      const result = parseProfileInput({ name, bio: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.name).toBeDefined();
    },
  );

  it("accepts a name of exactly the limit and rejects one over it", () => {
    expect(parseProfileInput({ name: "a".repeat(NAME_MAX_LENGTH), bio: "" }).ok).toBe(true);
    const over = parseProfileInput({ name: "a".repeat(NAME_MAX_LENGTH + 1), bio: "" });
    expect(over.ok).toBe(false);
  });

  it("measures the name after trimming", () => {
    const padded = ` ${"a".repeat(NAME_MAX_LENGTH)} `;
    expect(parseProfileInput({ name: padded, bio: "" }).ok).toBe(true);
  });

  it("counts characters, not UTF-16 units: 1000 emoji fit", () => {
    expect(parseProfileInput({ name: "a", bio: "😀".repeat(BIO_MAX_LENGTH) }).ok).toBe(true);
    const over = parseProfileInput({ name: "a", bio: "😀".repeat(BIO_MAX_LENGTH + 1) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.bio).toBeDefined();
  });

  it("accepts a bio of exactly the limit and rejects one over it", () => {
    expect(parseProfileInput({ name: "a", bio: "a".repeat(BIO_MAX_LENGTH) }).ok).toBe(true);
    expect(parseProfileInput({ name: "a", bio: "a".repeat(BIO_MAX_LENGTH + 1) }).ok).toBe(false);
  });

  it("counts a CRLF line break as one character and stores it as LF", () => {
    const bio = "a\r\n".repeat(BIO_MAX_LENGTH / 2); // 1000 characters once normalized
    const result = parseProfileInput({ name: "a", bio });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bio).toBe("a\n".repeat(BIO_MAX_LENGTH / 2));
  });

  it("rejects a NUL byte in the name or the bio", () => {
    const result = parseProfileInput({ name: "a\0b", bio: "c\0d" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBeDefined();
      expect(result.errors.bio).toBeDefined();
    }
  });

  it("rejects a bio that is not a string", () => {
    const result = parseProfileInput({ name: "a", bio: { x: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.bio).toBeDefined();
  });

  it("reports every invalid field at once", () => {
    const result = parseProfileInput({ name: "", bio: "a".repeat(BIO_MAX_LENGTH + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["bio", "name"]);
  });
});

function writers(overrides: Partial<ProfileWriters> = {}) {
  const updateName = vi.fn().mockResolvedValue(undefined);
  const updateBio = vi.fn().mockResolvedValue(undefined);
  const w: ProfileWriters = {
    currentName: "Ada",
    initialBio: "old bio",
    updateName,
    updateBio,
    ...overrides,
  };
  return { w, updateName, updateBio };
}

describe("saveProfile", () => {
  it("writes only the name when only the name changed", async () => {
    const { w, updateName, updateBio } = writers();
    const result = await saveProfile({ name: "Grace", bio: "old bio" }, w);
    expect(result).toEqual({ name: "saved", bio: "unchanged" });
    expect(updateName).toHaveBeenCalledWith("Grace");
    expect(updateBio).not.toHaveBeenCalled();
  });

  it("writes only the bio when only the bio changed", async () => {
    const { w, updateName, updateBio } = writers();
    const result = await saveProfile({ name: "Ada", bio: "new bio" }, w);
    expect(result).toEqual({ name: "unchanged", bio: "saved" });
    expect(updateName).not.toHaveBeenCalled();
    expect(updateBio).toHaveBeenCalledWith("new bio");
  });

  it("writes both when both changed", async () => {
    const { w, updateName, updateBio } = writers();
    const result = await saveProfile({ name: "Grace", bio: "new bio" }, w);
    expect(result).toEqual({ name: "saved", bio: "saved" });
    expect(updateName).toHaveBeenCalledOnce();
    expect(updateBio).toHaveBeenCalledOnce();
  });

  it("writes nothing when nothing changed, so resubmitting is harmless", async () => {
    const { w, updateName, updateBio } = writers();
    const result = await saveProfile({ name: "Ada", bio: "old bio" }, w);
    expect(result).toEqual({ name: "unchanged", bio: "unchanged" });
    expect(updateName).not.toHaveBeenCalled();
    expect(updateBio).not.toHaveBeenCalled();
  });

  it("can clear the bio with an empty string", async () => {
    const { w, updateBio } = writers();
    const result = await saveProfile({ name: "Ada", bio: "" }, w);
    expect(result.bio).toBe("saved");
    expect(updateBio).toHaveBeenCalledWith("");
  });

  it("does not touch the bio when the form did not offer it", async () => {
    const { w, updateBio } = writers({ initialBio: null });
    const result = await saveProfile({ name: "Grace", bio: null }, w);
    expect(result).toEqual({ name: "saved", bio: "unchanged" });
    expect(updateBio).not.toHaveBeenCalled();
  });

  it("writes the bio when the form's original bio is unknown", async () => {
    const { w, updateBio } = writers({ initialBio: null });
    const result = await saveProfile({ name: "Ada", bio: "x" }, w);
    expect(result.bio).toBe("saved");
    expect(updateBio).toHaveBeenCalledWith("x");
  });

  it("still saves the name when the bio write fails (the Go API is down)", async () => {
    const { w, updateName } = writers({
      updateBio: vi.fn().mockRejectedValue(new Error("API request failed with status 503")),
    });
    const result = await saveProfile({ name: "Grace", bio: "new bio" }, w);
    expect(result).toEqual({ name: "saved", bio: "failed" });
    expect(updateName).toHaveBeenCalledWith("Grace");
  });

  it("still saves the bio when the name write fails", async () => {
    const { w, updateBio } = writers({
      updateName: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const result = await saveProfile({ name: "Grace", bio: "new bio" }, w);
    expect(result).toEqual({ name: "failed", bio: "saved" });
    expect(updateBio).toHaveBeenCalledWith("new bio");
  });

  it("reports both as failed when both writes fail, without throwing", async () => {
    const { w } = writers({
      updateName: vi.fn().mockRejectedValue(new Error("a")),
      updateBio: vi.fn().mockRejectedValue(new Error("b")),
    });
    await expect(saveProfile({ name: "Grace", bio: "new bio" }, w)).resolves.toEqual({
      name: "failed",
      bio: "failed",
    });
  });

  it("retrying after a partial failure writes only what is still unsaved", async () => {
    const first = writers({
      updateBio: vi.fn().mockRejectedValue(new Error("503")),
    });
    await saveProfile({ name: "Grace", bio: "new bio" }, first.w);

    // After the first attempt the name is saved; the form re-renders with the new name.
    const second = writers({ currentName: "Grace" });
    const result = await saveProfile({ name: "Grace", bio: "new bio" }, second.w);
    expect(result).toEqual({ name: "unchanged", bio: "saved" });
    expect(second.updateName).not.toHaveBeenCalled();
  });
});

describe("toFormState", () => {
  const input = { name: "Grace", bio: "new bio" };

  it("marks saved fields and shows no error", () => {
    const state = toFormState(input, { name: "saved", bio: "unchanged" });
    expect(state.saved).toEqual({ name: true, bio: false });
    expect(state.errors).toEqual({});
    expect(state.values).toEqual(input);
  });

  it("shows an error only next to the field that failed, and still reports the other as saved", () => {
    const state = toFormState(input, { name: "saved", bio: "failed" });
    expect(state.saved).toEqual({ name: true, bio: false });
    expect(Object.keys(state.errors)).toEqual(["bio"]);
  });

  it("keeps the submitted values so a failed save does not wipe the user's input", () => {
    const state = toFormState(input, { name: "failed", bio: "failed" });
    expect(state.values).toEqual(input);
  });

  it("never puts raw error details into a message", () => {
    const state = toFormState(input, { name: "failed", bio: "failed" });
    for (const message of Object.values(state.errors)) {
      expect(message).not.toMatch(/status|token|Error:/i);
    }
  });
});

describe("shouldLeaveEditPage", () => {
  it.each<[string, Parameters<typeof shouldLeaveEditPage>[0], boolean]>([
    ["both saved", { name: "saved", bio: "saved" }, true],
    ["only the name saved", { name: "saved", bio: "unchanged" }, true],
    ["only the bio saved", { name: "unchanged", bio: "saved" }, true],
    ["nothing changed", { name: "unchanged", bio: "unchanged" }, true],
    ["the name failed", { name: "failed", bio: "unchanged" }, false],
    ["the bio failed", { name: "unchanged", bio: "failed" }, false],
    ["one saved and one failed (name saved)", { name: "saved", bio: "failed" }, false],
    ["one saved and one failed (bio saved)", { name: "failed", bio: "saved" }, false],
    ["both failed", { name: "failed", bio: "failed" }, false],
  ])("%s", (_label, result, expected) => {
    expect(shouldLeaveEditPage(result)).toBe(expected);
  });
});
