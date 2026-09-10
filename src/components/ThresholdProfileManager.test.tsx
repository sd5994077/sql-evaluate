// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThresholdProfile } from "../types";
import type { ThresholdProfileEntry } from "../rules/thresholdProfileStore";
import { createThresholdProfileSnapshot, DEFAULT_THRESHOLD_PROFILE, DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "../rules/thresholdProfiles";
import { ThresholdProfileManager } from "./ThresholdProfileManager";

afterEach(cleanup);

const builtInEntry: ThresholdProfileEntry = { profile: DEFAULT_THRESHOLD_PROFILE, snapshot: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, builtIn: true };

function customProfile(): ThresholdProfile {
  const profile = structuredClone(DEFAULT_THRESHOLD_PROFILE);
  profile.id = "dba.weekday";
  profile.version = "1.0.0";
  profile.name = "DBA weekday";
  return profile;
}

function renderManager(onStore = vi.fn().mockResolvedValue({ entry: builtInEntry, added: true })) {
  return render(<ThresholdProfileManager entries={[builtInEntry]} active={builtInEntry} ready warnings={[]} onActivate={vi.fn()} onStore={onStore} onDelete={vi.fn()} />);
}

describe("ThresholdProfileManager", () => {
  it("keeps a valid imported profile visible and ready to store", async () => {
    const profile = customProfile();
    const storedEntry: ThresholdProfileEntry = { profile, snapshot: await createThresholdProfileSnapshot(profile), builtIn: false };
    const onStore = vi.fn().mockResolvedValue({ entry: storedEntry, added: true });
    const { container } = renderManager(onStore);
    const file = new File([JSON.stringify(profile)], "dba-weekday.threshold-profile.json", { type: "application/json" });

    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByRole("status", { name: /profile ready to store: DBA weekday/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /store profile/i }));
    await waitFor(() => expect(onStore).toHaveBeenCalledWith(expect.objectContaining({ id: "dba.weekday" })));
    expect(await screen.findByRole("status", { name: /success: profile stored/i })).toBeTruthy();
    expect(screen.getByText(/was saved in this browser/i)).toBeTruthy();
  });

  it("explains that an exported bundled profile is already available", async () => {
    const { container } = renderManager();
    const file = new File([JSON.stringify(DEFAULT_THRESHOLD_PROFILE)], "published-defaults.threshold-profile.json", { type: "application/json" });

    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByRole("status", { name: /information: profile already available/i })).toBeTruthy();
    expect(screen.getByText(/is the built-in profile already available/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /store profile/i })).toBeNull();
  });

  it("reports an invalid profile beside the import control", async () => {
    const { container } = renderManager();
    const file = new File(["{not JSON"], "invalid.threshold-profile.json", { type: "application/json" });

    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    expect(await screen.findByRole("alert", { name: /error: profile import failed/i })).toBeTruthy();
  });
});
