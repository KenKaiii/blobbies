import { describe, expect, it } from "vitest";
import {
  MAX_BLOB_NAME_LENGTH,
  SAMPLE_MEMORIES,
  SAMPLE_USER_MEMORIES,
  uniqueBlobName,
} from "@/data/agents";

describe("uniqueBlobName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueBlobName("Scout", ["Quill", "Ledger"])).toBe("Scout");
  });

  it("suffixes a name another Blob already answers to", () => {
    // `@Scout` resolves to the first match, so a second Scout would be
    // permanently unmentionable and the user could not say which they meant.
    expect(uniqueBlobName("Scout", ["Scout"])).toBe("Scout 2");
    expect(uniqueBlobName("Scout", ["Scout", "Scout 2"])).toBe("Scout 3");
  });

  it("matches case-insensitively, because the mention matcher does", () => {
    expect(uniqueBlobName("scout", ["Scout"])).toBe("scout 2");
  });

  it("refuses names that @-addressing has already claimed", () => {
    // `@everyone` addresses the room, so a Blob called that could never be
    // reached on its own.
    expect(uniqueBlobName("Everyone", [])).toBe("Everyone 2");
  });

  it("keeps the suffix inside the length cap without re-colliding", () => {
    const long = "A".repeat(MAX_BLOB_NAME_LENGTH);
    const suffixed = uniqueBlobName(long, [long]);
    expect(suffixed.length).toBeLessThanOrEqual(MAX_BLOB_NAME_LENGTH);
    // Slicing a long name back to the cap could land it on the very name it
    // is avoiding; the suffix has to survive the trim.
    expect(suffixed).not.toBe(long);
    expect(suffixed.endsWith(" 2")).toBe(true);
  });

  it("returns an empty name untouched, so a rename can pass through it", () => {
    // The settings field is empty for a keystroke between two real names;
    // inventing one there would type over the user.
    expect(uniqueBlobName("  ", ["Scout"])).toBe("");
  });
});

describe("development memory seeds", () => {
  it("never injects invented personal facts into a live model prompt", () => {
    // Dev builds call real models with real user data. A visual fixture here
    // becomes a claimed identity/location once prompt assembly renders it.
    expect(SAMPLE_MEMORIES).toEqual([]);
    expect(SAMPLE_USER_MEMORIES).toEqual([]);
  });
});
