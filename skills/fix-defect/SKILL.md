---
name: fix-defect
description: Fix a bug test-first. Reproduce it as a failing regression test, find the root cause, make the smallest fix, verify with the repository's own checks, review, and only commit after the user confirms. Use when asked to fix a bug, a defect, a regression, a failing behavior or an incident follow-up.
---

# Fix a defect, test-first

A bug is fixed when a test that failed because of it now passes, and nothing else broke.
Work through these steps in order and do not skip the first two.

## 1. Reproduce it as a failing test

- Find the smallest input or sequence that shows the bug. Read the code path; don't guess.
- Write a regression test at the lowest level that captures the behavior (unit before
  integration, integration before end-to-end), named after the behavior, not the ticket.
- Run it and show it **fails for the right reason**: the wrong result, not an import error,
  a typo or a missing fixture.
- If you can't reproduce it, stop and report what you tried. Don't fix what you can't see.

## 2. Find the root cause

State in one or two sentences why the code does the wrong thing, pointing at the line or
decision responsible. A symptom ("it returns None") is not a cause ("the retry path swallows
the timeout and falls through to the default").

## 3. Make the smallest fix

- Change the code at the root cause, not where the symptom shows up.
- Do not edit the new test to make it pass, add suppression comments, or loosen a lint,
  type-check or test configuration.
- If the right fix is large or touches a public contract, stop and propose it first.

## 4. Verify

- Run the new test (it passes) and the related suite (nothing else broke).
- Run the repository's own build, lint and type checks, using the `verification-loop` skill
  when available. Show the commands and their output, not a summary of them.

## 5. Review

- If the repository or an installed plugin provides a code standard or a review skill,
  apply it to the diff. Otherwise run `/code-review`.
- When the bug involved error handling, run the `silent-failure-hunter` agent on the
  changed files: a swallowed error is often the bug's sibling.

## 6. Confirm, then commit

Present: the cause, the fix, the test that proves it, and the verification output. Wait for
the user to confirm, then commit following the repository's commit and pull request
conventions.
