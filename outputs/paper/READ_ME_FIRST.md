# Revised library-system paper

Prepared on 7 October 2026 (Asia/Manila) from the supplied partial paper and the local application source, including migrations 001–011. The original document was preserved.

## Deliverables

- `IBA_Library_System_REVISED.docx`: editable six-chapter paper.
- `IBA_Library_System_REVISED.pdf`: rendered reading copy.
- `IBA_Library_System_REVISED.md`: editable text source.
- `assets/`: four diagrams and ten screenshots, with screenshot capture provenance in `capture_log.json`.

The document follows the requested Chapter 1–6 outline and contains no system architecture section. It distinguishes physical library membership from online accounts, documents public catalog access and staff-managed circulation, and includes the newer course/subject search, book-request tracking, and stock-audit functions.

## Evidence still needed for final submission

1. Confirm Chapter 2 with actual interviews, observations, and library records. No respondent, quotation, error rate, or waiting-time measurement was invented.
2. Obtain approved institutional circulation rules. Code defaults are explicitly identified as defaults, not approved IBA policy.
3. Record controlled integration tests and user evaluation, then update the evaluation objective and conclusion with the actual results.
4. If the adviser requires live-system screenshots, replace the prototype demonstration figures after testing against an authorized test backend.

The screenshots show the actual React interface from a local source snapshot. Browser-intercepted synthetic responses provide illustrative data; no real Supabase authentication, hosted database operations, or live library records were used. Capturing the interface is not evidence that those backend operations passed. No public account creation is shown.

Source files were changing during preparation. The screenshot source snapshot is preserved in `prototype_snapshot/src`; the paper was reconciled with migration 011 and its accompanying interface. Recheck documentation if later system changes alter behavior.

`capture_prototype.py` and `build_paper.py` preserve the screenshot and document generation process. The app itself was not edited for this task. Word was used to render the PDF; page layout and image placement were reviewed.
