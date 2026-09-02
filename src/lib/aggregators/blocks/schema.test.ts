import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/blocks_golden_v1.json";
import {
  decodeBlock,
  decodeDocument,
  decodeRuns,
  encodeDocument,
  UnsupportedFormatVersion,
} from "./schema";

describe("block schema encoding / decoding", () => {
  it("asserts encodeDocument(decodeDocument(golden)) equals golden fixture", () => {
    const decoded = decodeDocument(golden);
    const reEncoded = encodeDocument(decoded);
    expect(reEncoded).toEqual(golden);
  });

  it("skips unknown block types and decodes known blocks", () => {
    const payload = {
      version: 1,
      blocks: [
        { type: "paragraph", runs: [{ text: "Hello", styles: [], link: null }] },
        { type: "future_fancy_block", data: "something" },
        { type: "divider" },
      ],
    };

    const decoded = decodeDocument(payload);
    expect(decoded).toEqual([
      {
        kind: "paragraph",
        runs: [
          {
            text: "Hello",
            bold: false,
            italic: false,
            code: false,
            strikethrough: false,
            link: "",
          },
        ],
      },
      { kind: "divider" },
    ]);
  });

  it("round-trips a summary block through the wire format", () => {
    const wire = {
      version: 1,
      blocks: [
        {
          type: "summary",
          blocks: [{ type: "paragraph", runs: [{ text: "The gist.", styles: [], link: null }] }],
        },
      ],
    };

    const decoded = decodeDocument(wire);
    expect(decoded[0]).toMatchObject({ kind: "summary", blocks: [{ kind: "paragraph" }] });
    // Version stays 1: a new type is additive under this format's own
    // extensibility rule (an unknown type is skipped, never fatal), and
    // bumping it would make every existing client reject the whole document.
    expect(encodeDocument(decoded)).toEqual(wire);
  });

  it("ignores unknown style names while preserving known styles", () => {
    const runsInput = [
      {
        text: "Styled",
        styles: ["bold", "unknown_style_name", "italic", "super_bold"],
        link: null,
      },
    ];

    const decoded = decodeRuns(runsInput);
    expect(decoded).toEqual([
      {
        text: "Styled",
        bold: true,
        italic: true,
        code: false,
        strikethrough: false,
        link: "",
      },
    ]);
  });

  it("throws UnsupportedFormatVersion for versions other than 1", () => {
    expect(() => decodeDocument({ version: 2, blocks: [] })).toThrow(UnsupportedFormatVersion);
    expect(() => decodeDocument({ version: 0, blocks: [] })).toThrow(UnsupportedFormatVersion);
    expect(() => decodeDocument(null)).toThrow(UnsupportedFormatVersion);
  });

  it("decodes unrecognized embed provider to generic", () => {
    const block = decodeBlock({
      type: "embed",
      provider: "some_unknown_video_site",
      externalURL: "https://example.com/video",
    });

    expect(block).toEqual({
      kind: "embed",
      provider: "generic",
      externalUrl: "https://example.com/video",
      thumbnailRef: "",
      title: "",
    });
  });
});
