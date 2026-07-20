import { test, expect, describe } from "bun:test";
import { splitAnnexBNals, spsToCodecString, type AnnexBNal } from "./h264decode.ts";

/**
 * Unit tests for the pure Annex-B NAL-unit splitter and SPS codec-string
 * derivation. No WebCodecs/VideoDecoder involved -- just hand-built byte
 * buffers, matching splitJpegFrames's test style in src/tracking.test.ts
 * (and this project's tracking.test.ts style generally: hand-written
 * fixtures, no mocking framework, behavior-focused assertions). H264Stream
 * itself (the VideoDecoder-driving class) needs a real browser and is
 * exercised via useLocalTrack instead -- not unit-testable here.
 */

const SC3 = [0x00, 0x00, 0x01]; // 3-byte start code
const SC4 = [0x00, 0x00, 0x00, 0x01]; // 4-byte start code

/** Builds a fake NAL: header byte encodes nal_ref_idc=3, type=`type`. */
function nalHeader(type: number): number {
  return (3 << 5) | type; // forbidden_zero_bit=0, nal_ref_idc=3
}

describe("splitAnnexBNals", () => {
  test("single complete NAL (3-byte start code) in one chunk -> withheld until a next start code arrives", () => {
    // Annex-B has no length prefix -- a trailing NAL is never "complete"
    // until the NEXT start code is seen, so a lone NAL yields zero NALs and
    // everything held in `rest`.
    const chunk = new Uint8Array([...SC3, nalHeader(1), 0xaa, 0xbb, 0xcc]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(Array.from(rest)).toEqual(Array.from(chunk));
  });

  test("two complete NALs (4-byte start codes) in one chunk -> first NAL returned, second withheld", () => {
    const nal1 = [nalHeader(7), 0x11, 0x22];
    const nal2 = [nalHeader(1), 0x33, 0x44, 0x55];
    const chunk = new Uint8Array([...SC4, ...nal1, ...SC4, ...nal2]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(nals[0]!.type).toBe(7);
    expect(Array.from(nals[0]!.data)).toEqual(nal1);
    expect(Array.from(rest)).toEqual([...SC4, ...nal2]);
  });

  test("three NALs, mixed 3-byte and 4-byte start codes, all in one chunk -> first two returned in order", () => {
    const sps = [nalHeader(7), 0x01];
    const pps = [nalHeader(8), 0x02];
    const slice = [nalHeader(5), 0x03, 0x04];
    const chunk = new Uint8Array([...SC4, ...sps, ...SC3, ...pps, ...SC3, ...slice]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(2);
    expect(nals[0]!.type).toBe(7);
    expect(Array.from(nals[0]!.data)).toEqual(sps);
    expect(nals[1]!.type).toBe(8);
    expect(Array.from(nals[1]!.data)).toEqual(pps);
    expect(Array.from(rest)).toEqual([...SC3, ...slice]);
  });

  test("NAL payload split across two chunks -> first call withholds it, second call completes it", () => {
    const nal1 = [nalHeader(1), 0xaa, 0xbb, 0xcc, 0xdd];
    const nal2 = [nalHeader(1), 0xee];
    const full = new Uint8Array([...SC3, ...nal1, ...SC3, ...nal2]);
    const chunk1 = full.slice(0, 5); // start code + partial nal1 payload
    const chunk2 = full.slice(5); // rest of nal1 + start code + nal2

    const first = splitAnnexBNals(new Uint8Array(0), chunk1);
    expect(first.nals.length).toBe(0);
    expect(Array.from(first.rest)).toEqual(Array.from(chunk1));

    const second = splitAnnexBNals(first.rest, chunk2);
    expect(second.nals.length).toBe(1);
    expect(second.nals[0]!.type).toBe(1);
    expect(Array.from(second.nals[0]!.data)).toEqual(nal1);
    expect(Array.from(second.rest)).toEqual([...SC3, ...nal2]);
  });

  test("3-byte start code split across chunk boundary (1 byte in, 2 out) -> reassembled, not dropped or duplicated", () => {
    const nal1 = [nalHeader(1), 0x01];
    const nal2 = [nalHeader(1), 0x02];
    const full = new Uint8Array([...SC3, ...nal1, ...SC3, ...nal2]);
    // Split the SECOND start code (index 4..6) right after its first byte.
    const splitAt = 3 + nal1.length + 1;
    const chunk1 = full.slice(0, splitAt);
    const chunk2 = full.slice(splitAt);

    const first = splitAnnexBNals(new Uint8Array(0), chunk1);
    expect(first.nals.length).toBe(0); // nal1 not complete yet -- its terminating start code hasn't fully arrived

    const second = splitAnnexBNals(first.rest, chunk2);
    expect(second.nals.length).toBe(1);
    expect(Array.from(second.nals[0]!.data)).toEqual(nal1);
    expect(Array.from(second.rest)).toEqual([...SC3, ...nal2]);
  });

  test("4-byte start code split byte-by-byte across four chunks -> still reassembled correctly", () => {
    const nal1 = [nalHeader(5), 0x01, 0x02];
    const nal2 = [nalHeader(1), 0x03];
    const full = new Uint8Array([...SC4, ...nal1, ...SC4, ...nal2]);

    let pending: Uint8Array = new Uint8Array(0);
    let nalsFound: AnnexBNal[] = [];
    // Feed one byte at a time through the whole buffer.
    for (let i = 0; i < full.length; i++) {
      const { nals, rest } = splitAnnexBNals(pending, full.slice(i, i + 1));
      nalsFound = nalsFound.concat(nals);
      pending = rest;
    }
    expect(nalsFound.length).toBe(1);
    expect(Array.from(nalsFound[0]!.data)).toEqual(nal1);
    expect(Array.from(pending)).toEqual([...SC4, ...nal2]);
  });

  test("garbage bytes before the first start code are dropped, never surfaced as a NAL", () => {
    const nal1 = [nalHeader(1), 0x9];
    const chunk = new Uint8Array([0xde, 0xad, 0xbe, 0xef, ...SC3, ...nal1, ...SC3]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(Array.from(nals[0]!.data)).toEqual(nal1);
    expect(Array.from(rest)).toEqual(SC3);
  });

  test("no start code anywhere -> no NALs, non-zero-prefixed garbage fully dropped", () => {
    const chunk = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(rest.length).toBe(0);
  });

  test("trailing zero bytes with no start code yet -> kept as a potential start-code prefix", () => {
    const chunk = new Uint8Array([0xaa, 0xbb, 0x00, 0x00]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(Array.from(rest)).toEqual([0x00, 0x00]);
  });

  test("empty chunk -> no NALs, rest unchanged from pending", () => {
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), new Uint8Array(0));
    expect(nals.length).toBe(0);
    expect(rest.length).toBe(0);
  });

  test("empty (zero-length) NAL between two adjacent start codes is silently skipped, not emitted", () => {
    const nal2 = [nalHeader(1), 0x7];
    const chunk = new Uint8Array([...SC3, ...SC3, ...nal2, ...SC3]);
    const { nals } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(Array.from(nals[0]!.data)).toEqual(nal2);
  });
});

describe("spsToCodecString", () => {
  test("no-escaping-needed SPS -> avc1.PPCCLL directly from profile/constraint/level bytes", () => {
    const sps = new Uint8Array([nalHeader(7), 0x42, 0xc0, 0x1e]);
    expect(spsToCodecString(sps)).toBe("avc1.42c01e");
  });

  test("SPS requiring emulation-prevention removal -> reads the DE-ESCAPED bytes, not the raw ones", () => {
    // Semantic RBSP (post-header): profile=0x00, constraint=0x00, level=0x01
    // -- "00 00 01" must be escaped in the real Annex-B byte stream to
    // "00 00 03 01" per H.264 7.4.1.1, or it would be indistinguishable
    // from a start code. Reading the wrong (still-escaped) bytes would
    // yield "avc1.000003" instead of the correct "avc1.000001".
    const escapedSps = new Uint8Array([nalHeader(7), 0x00, 0x00, 0x03, 0x01]);
    expect(spsToCodecString(escapedSps)).toBe("avc1.000001");
  });

  test("throws on an SPS too short to contain profile/constraint/level", () => {
    expect(() => spsToCodecString(new Uint8Array([nalHeader(7), 0x42]))).toThrow();
  });
});
