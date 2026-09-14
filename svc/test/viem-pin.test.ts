// viem's version is PINNED, and this asserts the pin is real.
//
// The fee guard's header says "when viem is upgraded, somebody has to read its
// changelog for new transaction methods; this file cannot." That sentence named
// an event with no trigger: the manifest declared `^2.40.0` and 2.56.3 was
// installed, so SIXTEEN MINORS had arrived with nobody deciding anything. A
// stated gap whose statement describes a moment that silently already happened
// sixteen times is not a control.
//
// So the caret is gone and this fails on any bump. It trades a red on every
// upgrade for a human reading the changelog, which is exactly the trade the
// sentence was asking for and never got.

import { describe, it, expect } from 'bun:test';

// The manifest, not a literal repeated here: two copies of the pin would drift,
// and the one this test checked would be the one nobody upgraded.
import manifest from '../package.json' with { type: 'json' };

describe('viem is pinned, not ranged', () => {
  it('declares an exact version', () => {
    const declared = (manifest.dependencies as Record<string, string>).viem;
    // No range operators: `^` or `~` would let a minor arrive undecided again.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // TWO AUTHORITIES RECORD THE DECLARED VERSION, AND ONLY ONE OF THEM IS IN
  // package.json. `bun.lock` carries the requested RANGE as well as the
  // resolution, and it kept saying `^2.40.0` after the manifest was pinned -
  // in the very change whose purpose was to make this version an explicit
  // decision.
  //
  // `bun install --frozen-lockfile` does NOT catch it: measured, exit 0 with no
  // complaint, because no package RESOLUTION changed - only the declaration
  // record. So the mechanism that exists to detect manifest/lock divergence is
  // blind to this particular divergence.
  //
  // What it costs is PROVENANCE, which is what the pin is actually buying: the
  // next plain `bun install` writes that line under whatever PR happens to be
  // open, so the decision detaches from the change that made it - and a
  // lockfile line arriving in an unrelated PR is exactly the shape nobody
  // reviews.
  it('is pinned in the LOCKFILE too, not only in the manifest', async () => {
    const declared = (manifest.dependencies as Record<string, string>).viem;
    const lock = await Bun.file(new URL('../../bun.lock', import.meta.url)).text();
    // The requested range as the lockfile records it for this workspace.
    expect(lock).toContain(`"viem": "${declared}"`);
    expect(lock).not.toMatch(/"viem": "[\^~]/);
  });

  // THE PATH MATTERS AND IS THE REASON THIS TEST IS TRUSTWORTHY. viem is
  // installed under svc, not at the repo root; the first version of
  // this control read the root and BOTH ARMS FAILED IDENTICALLY on a missing
  // path - the pinned arm and the mutated arm alike. A CONTROL WHOSE HALVES
  // AGREE HAS MEASURED NOTHING. Reading the resolved module rather than a path
  // guess is what makes the two arms able to diverge.
  it('has exactly that version installed', async () => {
    const declared = (manifest.dependencies as Record<string, string>).viem;
    const installed = (
      await import('viem/package.json', { with: { type: 'json' } })
    ).default.version as string;
    expect(installed).toBe(declared);
  });
});
