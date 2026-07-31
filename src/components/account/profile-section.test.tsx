import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { avatarUrlFor } from "@/lib/avatar";
import { renderWithProviders } from "@/test/render";

import { ProfileSection } from "./profile-section";

/**
 * The server actions, stubbed -- and only the server actions.
 *
 * They are `"use server"` modules over a native SQLite driver and `sharp`;
 * neither belongs in jsdom, and what they do is covered for real against a
 * database in `src/lib/account/account.test.ts`. What this file is about is
 * what the *card* does with the answer. Messages are never stubbed:
 * `renderWithProviders` mounts the shipped catalogs.
 */
const { updateProfile, uploadAvatar, removeAvatar } = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatar: vi.fn(),
}));
vi.mock("@/lib/account/actions", () => ({ updateProfile, uploadAvatar, removeAvatar }));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const ADA = {
  id: "Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  image: null,
};

/**
 * Every URL the tree would actually fetch.
 *
 * Asserting on the DOM proves nothing about an avatar: Base UI's `AvatarImage`
 * returns `null` until a `new window.Image()` load resolves, and jsdom never
 * loads images, so no `<img>` ever reaches the document whatever `src` was
 * passed. The interception point is `HTMLImageElement.prototype.src` and not
 * `window.Image`, because jsdom defines `window.Image` as an accessor and
 * assigning to it silently does nothing -- a trap task 5 lost a test to. Same
 * seam as `src/components/user-avatar.test.tsx`.
 */
let requested: string[] = [];
const realSrc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, "src")!;

beforeEach(() => {
  requested = [];
  vi.clearAllMocks();
  Object.defineProperty(window.HTMLImageElement.prototype, "src", {
    configurable: true,
    get: realSrc.get,
    set(value: string) {
      requested.push(value);
    },
  });
});

afterEach(() => {
  Object.defineProperty(window.HTMLImageElement.prototype, "src", realSrc);
});

describe("<ProfileSection>", () => {
  it("seeds the three fields from the row it was given", () => {
    renderWithProviders(<ProfileSection user={ADA} />);

    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
    expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Last name") as HTMLInputElement).value).toBe("Lovelace");
  });

  it("states both upload limits, in the active locale", () => {
    // Asserted against de.json: the numbers are the same in both catalogs, so
    // English would not prove the sentence is translated. And the *numbers*
    // come from @/lib/avatar, so a limit change cannot leave the help text
    // claiming the old one.
    const { container } = renderWithProviders(<ProfileSection user={ADA} />, { locale: "de" });

    const text = container.textContent ?? "";
    expect(text).toContain("höchstens 2 MB und 25 Megapixel");
    expect(text).toContain("256×256");
  });

  it("renders a stored avatar through the guarded helper, and requests it", () => {
    // The first thing in this tree that renders an uploaded avatar at all.
    renderWithProviders(<ProfileSection user={{ ...ADA, image: avatarUrlFor(ADA.id) }} />);

    expect(requested).toEqual([avatarUrlFor(ADA.id)]);
  });

  it("requests nothing for a column value that is not this user's avatar URL", () => {
    // `users.image` is attacker-controlled and this card renders it; an
    // external URL would be an IP/user-agent/referrer beacon.
    renderWithProviders(
      <ProfileSection user={{ ...ADA, image: "https://evil.example.com/track.gif" }} />,
    );

    expect(requested).toEqual([]);
    expect(document.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("AL");
  });

  it("offers removal only when there is a picture to remove", () => {
    const { container, unmount } = renderWithProviders(<ProfileSection user={ADA} />);
    expect(container.textContent).not.toContain("Remove picture");
    unmount();

    const withPicture = renderWithProviders(
      <ProfileSection user={{ ...ADA, image: avatarUrlFor(ADA.id) }} />,
    );
    expect(withPicture.container.textContent).toContain("Remove picture");
  });

  it("sends the edited fields and reports the catalog message the action names", async () => {
    updateProfile.mockResolvedValue({ ok: false, errorKey: "profile.emailTaken" });
    renderWithProviders(<ProfileSection user={ADA} />, { locale: "de" });

    fireEvent.change(screen.getByLabelText("Vorname"), { target: { value: "Augusta" } });
    fireEvent.submit(screen.getByLabelText("Vorname").closest("form")!);
    await vi.waitFor(() => expect(updateProfile).toHaveBeenCalled());

    expect(updateProfile).toHaveBeenCalledWith({
      email: "ada@example.com",
      firstName: "Augusta",
      lastName: "Lovelace",
    });
    // The German sentence, not the key and not an English driver message.
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Diese E-Mail-Adresse wird bereits von einem anderen Konto verwendet.",
      ),
    );
  });

  it("refuses an oversized file without calling the action at all", async () => {
    // Found live, not reasoned about: Next caps a Server Action request body
    // (`serverActions.bodySizeLimit` in next.config.ts), so a file well past
    // the avatar limit is rejected by the framework and the action never runs
    // -- which showed up in a browser as an upload that produced no message
    // whatsoever. The client-side check is what turns that into a translated
    // sentence naming the limit. The two server-side checks stay; this one is
    // about what the user is told.
    updateProfile.mockResolvedValue({ ok: true });
    const { container } = renderWithProviders(<ProfileSection user={ADA} />, { locale: "de" });

    const huge = new File([new Uint8Array(3 * 1024 * 1024)], "huge.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [huge] },
    });

    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Diese Datei ist größer als 2 MB. Wähle ein kleineres Bild.",
    );
  });

  it("does send a file within the limit", () => {
    // The control: a guard that refused everything would pass the test above
    // and break every real upload.
    uploadAvatar.mockResolvedValue({ ok: true });
    const { container } = renderWithProviders(<ProfileSection user={ADA} />);

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(["small"], "me.png", { type: "image/png" })] },
    });

    expect(uploadAvatar).toHaveBeenCalled();
  });

  it.each([
    ["a profile save", () => updateProfile],
    ["an avatar upload", () => uploadAvatar],
  ])("survives %s that rejects instead of returning", async (_label, action) => {
    // Not a thought experiment: an over-sized body makes Next reject the
    // action, and an unhandled rejection inside a useTransition scope escalates
    // to the (app) error boundary -- the whole page becomes "Something went
    // wrong" and the half-typed form is gone. attempt() is what stops it.
    action().mockRejectedValue(new Error("Body exceeded 2304kb limit"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container } = renderWithProviders(<ProfileSection user={ADA} />, { locale: "de" });

      if (action() === updateProfile) {
        fireEvent.submit(screen.getByLabelText("Vorname").closest("form")!);
      } else {
        fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
          target: { files: [new File(["small"], "me.png", { type: "image/png" })] },
        });
      }

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut.",
        ),
      );
      // Still mounted, still holding what was typed -- the page did not go away.
      expect((screen.getByLabelText("Vorname") as HTMLInputElement).value).toBe("Ada");
    } finally {
      logged.mockRestore();
    }
  });

  it("names the megapixel limit when the upload is refused", async () => {
    // The requirement the brief is explicit about: never "processing failed".
    updateProfile.mockResolvedValue({ ok: true });
    uploadAvatar.mockResolvedValue({ ok: false, errorKey: "avatar.rejected" });
    const { container } = renderWithProviders(<ProfileSection user={ADA} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "huge.png", { type: "image/png" })] },
    });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    const message = String(toastError.mock.calls.at(-1)?.[0]);
    expect(message).toContain("25 megapixels");
    expect(message).not.toMatch(/processing failed/i);
  });
});
