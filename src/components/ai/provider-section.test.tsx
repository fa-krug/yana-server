import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProviderKey } from "@/lib/ai/providers";
import type { AiProviderStatus } from "@/lib/ai/queries";
import { KEEP_EXISTING } from "@/lib/secrets";
import { renderWithProviders } from "@/test/render";

import { ProviderSection } from "./provider-section";

const { removeProvider, saveProvider, setActiveProvider, testProvider } = vi.hoisted(() => ({
  removeProvider: vi.fn(),
  saveProvider: vi.fn(),
  setActiveProvider: vi.fn(),
  testProvider: vi.fn(),
}));
vi.mock("@/lib/ai/actions", () => ({
  removeProvider,
  saveProvider,
  setActiveProvider,
  testProvider,
}));

// The real stub module, never an inline factory: `attempt()` reaches
// `unstable_rethrow`, and a hand-written mock that forgot it kills the file.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { toastError, toastSuccess, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess, warning: toastWarning },
}));

/** What a configured provider looks like: eight bullets and a four-character tail. */
const MASK = "••••••••Ab12";

const PROVIDERS: Record<AiProviderKey, AiProviderStatus> = {
  openai: {
    enabled: false,
    apiKeyMasked: "",
    apiUrl: "https://gateway.example.com/v1",
    model: "gpt-5.6-luna",
  },
  anthropic: { enabled: true, apiKeyMasked: MASK, apiUrl: "", model: "claude-haiku-4-5" },
  gemini: { enabled: false, apiKeyMasked: "", apiUrl: "", model: "gemini-3.5-flash-lite" },
};

function render(active: AiProviderKey | "", locale: "en" | "de" = "de") {
  return renderWithProviders(<ProviderSection active={active} providers={PROVIDERS} />, { locale });
}

/**
 * The text on a **collapsed** select trigger.
 *
 * The whole point of the assertion: Base UI resolves this from the root's
 * `items` prop and never from `<SelectItem>`'s children, so opening the popup
 * and reading a translated option proves nothing about what an operator sees
 * before they open it.
 */
function triggerText(container: HTMLElement, id: string): string | undefined {
  return container.querySelector(`#${id} [data-slot="select-value"]`)?.textContent ?? undefined;
}

/**
 * Open a select and click one of its options, by the label on the option.
 *
 * **The `pointerDown` is required, not decoration.** Base UI's item refuses a
 * click it did not see a pointer press start on (`allowMouseSelectionRef` in
 * `select/item/SelectItem`), because opening with `alignItemWithTrigger` can
 * place an item directly under the cursor. `fireEvent.click` alone therefore
 * opens the popup, highlights nothing and commits nothing -- which looks
 * exactly like a component that ignored the choice.
 */
function choose(id: string, option: string): void {
  fireEvent.click(document.querySelector<HTMLElement>(`#${id}`)!);
  const item = screen.getByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function submit(): void {
  fireEvent.submit(document.querySelector<HTMLFormElement>("form")!);
}

describe("<ProviderSection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveProvider.mockResolvedValue({ ok: true });
    testProvider.mockResolvedValue({ ok: true });
    removeProvider.mockResolvedValue({ ok: true });
    setActiveProvider.mockResolvedValue({ ok: true });
  });

  describe('the "None (disabled)" option', () => {
    it("is what the collapsed trigger reads when no provider is active", () => {
      // `""` is a listed item, not an absence -- but Base UI's own
      // `hasSelectedValue` is `stringifyAsValue(value) !== ""`, so it reads as
      // *unselected*. That only resolves to the None label because this
      // `<SelectValue>` passes no `placeholder` prop; adding one would replace
      // this text with it and the page would look unconfigured in a new way.
      const { container } = render("");

      expect(triggerText(container, "ai-provider")).toBe("Keiner (deaktiviert)");
    });

    it("offers no credential fields and no Test button", () => {
      render("");

      expect(screen.queryByLabelText("API-Schlüssel")).toBe(null);
      expect(screen.queryByLabelText("Modell")).toBe(null);
      expect(screen.queryByRole("button", { name: "Testen" })).toBe(null);
      expect(screen.getByText("Die KI-Funktionen sind ausgeschaltet.")).toBeTruthy();
    });

    it("writes the empty string when it is saved", async () => {
      // The round trip that phase 9 depends on: `""` out of the select, `""`
      // into `active_ai_provider`, and no attempt to verify a credential that
      // does not exist.
      render("");

      fireEvent.click(screen.getByRole("button", { name: "KI ausschalten" }));

      await waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith(""));
      expect(saveProvider).not.toHaveBeenCalled();
    });

    it("is reachable from an active provider, and says the change is not applied", () => {
      const { container } = render("anthropic");

      choose("ai-provider", "Keiner (deaktiviert)");

      expect(triggerText(container, "ai-provider")).toBe("Keiner (deaktiviert)");
      // The picker has moved and the server has not: saying so is the whole
      // reason choosing a provider does not write anything by itself.
      expect(
        screen.getByText("Noch nicht übernommen — speichere, um die KI-Funktionen auszuschalten."),
      ).toBeTruthy();
    });
  });

  describe("the selected provider", () => {
    it("shows its brand name and its model's label on the collapsed triggers", () => {
      // A stored id with no matching item makes Base UI print the raw value, so
      // `claude-haiku-4-5` on this trigger is the defect being guarded against.
      const { container } = render("anthropic");

      expect(triggerText(container, "ai-provider")).toBe("Anthropic");
      expect(triggerText(container, "ai-model")).toBe("Claude Haiku 4.5");
    });

    it("shows the mask as a placeholder and never as a value", () => {
      // The stored key is not in this component's props, so the strongest local
      // statement is that the field is empty and only the mask is visible -- and
      // that the mask is a placeholder, because a value would be submitted back
      // on the next save.
      render("anthropic");

      const input = field("API-Schlüssel");
      expect(input.value).toBe("");
      expect(input.placeholder).toBe(MASK);
      expect(input.type).toBe("password");
      expect(input.autocomplete).toBe("off");
      // Asserted against de.json: "Verified" is close enough to the raw flag to
      // prove nothing about the catalog being wired up at all.
      expect(screen.getByText("Geprüft")).toBeTruthy();
      expect(screen.getByText("Die KI-Funktionen verwenden diesen Anbieter.")).toBeTruthy();
    });

    it("offers a base URL where the provider declares one", () => {
      render("openai");

      expect(field("Basis-URL").value).toBe("https://gateway.example.com/v1");
    });

    it("offers none where the endpoint is fixed", () => {
      // Separate renders rather than two in one test: testing-library only
      // cleans up between tests, so a second render would leave the first
      // card's field in the document and the query would find it.
      render("gemini");

      expect(screen.queryByLabelText("Basis-URL")).toBe(null);
    });

    it("reports an unverified provider as such", () => {
      render("gemini");

      expect(screen.getByText("Ungeprüft")).toBeTruthy();
      expect(
        screen.getByText("Für diesen Anbieter ist noch kein Schlüssel hinterlegt."),
      ).toBeTruthy();
    });
  });

  describe("saving", () => {
    it("submits the keep-existing sentinel when the key was never touched", async () => {
      render("anthropic");

      submit();

      await waitFor(() =>
        expect(saveProvider).toHaveBeenCalledWith("anthropic", {
          apiKey: KEEP_EXISTING,
          model: "claude-haiku-4-5",
        }),
      );
      expect(toastSuccess).toHaveBeenCalledWith("Zugangsdaten geprüft und gespeichert.");
    });

    it("does not rewrite the preference when the provider is already the active one", async () => {
      render("anthropic");

      submit();

      await waitFor(() => expect(saveProvider).toHaveBeenCalled());
      expect(setActiveProvider).not.toHaveBeenCalled();
    });

    it("makes the chosen provider the active one once its credentials verify", async () => {
      // The two-press dead end this design exists to avoid: `setActiveProvider`
      // refuses a provider that has not passed a probe, and after the save that
      // makes it pass, the picker's value is already `openai` -- so re-picking
      // it fires nothing.
      render("");
      choose("ai-provider", "OpenAI");
      fireEvent.change(field("API-Schlüssel"), { target: { value: "sk-proj-a-real-key" } });

      submit();

      await waitFor(() =>
        expect(saveProvider).toHaveBeenCalledWith("openai", {
          apiKey: "sk-proj-a-real-key",
          model: "gpt-5.6-luna",
          apiUrl: "https://gateway.example.com/v1",
        }),
      );
      await waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith("openai"));
      // Cleared on success, so the refreshed placeholder is what shows and the
      // key is not sitting in the DOM waiting to be re-submitted.
      await waitFor(() => expect(field("API-Schlüssel").value).toBe(""));
    });

    it("activates nothing when the provider refused the credentials", async () => {
      saveProvider.mockResolvedValue({ ok: false, errorKey: "openai.rejected" });
      render("");
      choose("ai-provider", "OpenAI");
      fireEvent.change(field("API-Schlüssel"), { target: { value: "wrong" } });

      submit();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          expect.stringContaining("OpenAI hat diese Zugangsdaten nicht akzeptiert"),
        ),
      );
      expect(setActiveProvider).not.toHaveBeenCalled();
      // A typo is corrected, not retyped.
      expect(field("API-Schlüssel").value).toBe("wrong");
    });

    it("reports a quota answer as a warning, not as a success or a failure", async () => {
      // The key is valid and only the budget is gone: a red toast would send the
      // operator back to re-save something that already worked, and a green one
      // would hide why the summaries stop.
      saveProvider.mockResolvedValue({ ok: true, noticeKey: "anthropic.quota" });
      render("anthropic");

      submit();

      await waitFor(() =>
        expect(toastWarning).toHaveBeenCalledWith(
          expect.stringContaining("Der Schlüssel ist gültig"),
        ),
      );
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("survives a save that rejects instead of returning", async () => {
      // Unhandled, this rejection escalates to the (app) error boundary and
      // takes the half-typed key with it. `attempt()` is what turns it into a
      // toast.
      saveProvider.mockRejectedValue(new Error("the container restarted"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        render("anthropic", "en");
        fireEvent.change(field("API key"), { target: { value: "sk-ant-a-new-key" } });
        submit();

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith(
            "The server did not answer. Check your connection and try again.",
          ),
        );
        expect(field("API key").value).toBe("sk-ant-a-new-key");
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe("switching provider", () => {
    it("clears the typed key and re-seeds the model", () => {
      // The key belongs to the provider that was selected when it was typed;
      // carrying it across would submit an Anthropic key to Gemini.
      const { container } = render("anthropic");
      fireEvent.change(field("API-Schlüssel"), { target: { value: "sk-ant-typed-here" } });

      choose("ai-provider", "Gemini");

      expect(field("API-Schlüssel").value).toBe("");
      expect(triggerText(container, "ai-model")).toBe("Gemini 3.5 Flash-Lite");
      expect(
        screen.getByText(
          "Noch nicht aktiv — speichere und prüfe diese Zugangsdaten, um die KI-Funktionen auf diesen Anbieter umzustellen.",
        ),
      ).toBeTruthy();
    });

    it("submits the model that was picked, not the stored one", async () => {
      render("anthropic");

      choose("ai-model", "Claude Opus 5");
      submit();

      await waitFor(() =>
        expect(saveProvider).toHaveBeenCalledWith("anthropic", {
          apiKey: KEEP_EXISTING,
          model: "claude-opus-5",
        }),
      );
    });
  });

  describe("testing and removing", () => {
    it("tests the submitted credentials without saving them", async () => {
      render("anthropic");

      fireEvent.change(field("API-Schlüssel"), { target: { value: "a-candidate" } });
      fireEvent.click(screen.getByRole("button", { name: "Testen" }));

      await waitFor(() =>
        expect(testProvider).toHaveBeenCalledWith("anthropic", {
          apiKey: "a-candidate",
          model: "claude-haiku-4-5",
        }),
      );
      expect(saveProvider).not.toHaveBeenCalled();
      expect(setActiveProvider).not.toHaveBeenCalled();
      expect(toastSuccess).toHaveBeenCalledWith("Diese Zugangsdaten funktionieren.");
    });

    /**
     * The fallback message names the action that failed.
     *
     * A `{ ok: false }` with no key of its own is reachable from every action
     * here, and a single fallback answered all of them with "could not be
     * saved" -- told to an operator who pressed **Test**, about a call that
     * never writes.
     */
    it.each([
      ["Testen", "Diese Zugangsdaten konnten nicht getestet werden."],
      ["Speichern und prüfen", "Diese Zugangsdaten konnten nicht gespeichert werden."],
    ])("blames the right action when %s fails with no key", async (button, message) => {
      saveProvider.mockResolvedValue({ ok: false });
      testProvider.mockResolvedValue({ ok: false });
      render("anthropic");

      fireEvent.click(screen.getByRole("button", { name: button }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
    });

    it("offers no remove button until something is stored", () => {
      render("gemini");

      expect(screen.queryByRole("button", { name: "Zugangsdaten entfernen" })).toBe(null);
    });

    it("removes the stored key behind a confirmation", async () => {
      render("anthropic");

      fireEvent.click(screen.getByRole("button", { name: "Zugangsdaten entfernen" }));
      expect(screen.getByText("Diese Zugangsdaten entfernen?")).toBeTruthy();
      // The popup's confirm, not the trigger.
      const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!;
      fireEvent.click(within(popup).getByRole("button", { name: "Entfernen" }));

      await waitFor(() => expect(removeProvider).toHaveBeenCalledWith("anthropic"));
      expect(toastSuccess).toHaveBeenCalledWith("Zugangsdaten entfernt.");
    });
  });
});
