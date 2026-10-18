## Release boundary — Creator 3.7 first

- [x] Owner decision recorded: complete build/security, clean qualification, packaging, publish and release for the supported Creator 3.7 artifact before reopening any 3.8/API-resume lane.
- [x] Keep this change `status: pending`; do not use its 3.8 probes, forward-runtime evidence or pending candidates as Creator 3.7 release credit or blockers.

### Owner review boundary — implementation only, 2026-10-09

Approve/review implemented source independently from testing. Existing test outputs remain recorded historical evidence; every future verification/re-verification task stays pending for a separately scheduled pass. No test execution, live mutation, qualification promotion, publish readiness or release closure is authorized by this review decision.

### Breadth-freeze reconciliation — 2026-10-18

- [x] Current API expansion source stabilization completed in `b5800154`: all review findings fixed; integrated build/Creator-load and full unit897/897 pass. Current offline portfolio/workflow/authoring audits pass (368 registered, approvals70/82, readiness:false, authoring228/247).
- [x] Separate current source completion from historical release and future re-entry checklists. Unchecked rows below cover exact native/clean-artifact/protected qualification or future lanes; they are not outstanding authorization to add API breadth.
- [x] Keep frozen parent pending/HOLD and thresholds unchanged. Canonical current implementation/qualification split: `G:/_devtools/cfg-n-scripts/notes/plans/cc-code-mode-cst/1-wip-261015__tbd-parallel-api-capability-expansion/plan.md`.

The final-artifact `commit/builtAt`, native persistence/restart/cleanup and signing/release checks remain unchecked until actually exercised. Passing local build/unit/audits does not complete those compound requirements or replace historical witnesses.

#### Implemented and accepted for source review

- [x] `buildSettingsManage`: allowlisted builder defaults/cache preferences with guarded writes/read-back/rollback logic.
- [x] `buildProfileManage`: bounded CCP-owned project build profiles, option auditing, credential refusal and guarded persistence logic; not native Creator presets.
- [x] `buildTemplate`: six target/debug-release option templates with scene/start-scene syntax and nested platform validation; no dispatch.
- [x] Prefab follow-through: bounded instance/source inspection, source-hash apply guard, source diff and capped-validation completeness logic; not a variant asset.
- [x] Existing UI layout/report and popup observability/action implementation; combined live verification remains separate.
- [x] Final CCP naming/registry/bootstrap/protocol source cutover; owned migration tooling exists but workstation apply is not performed.
- [x] P0 task identities: safe numeric/string IDs normalized across get/control/wait/log and summaries; malformed IDs refused before dispatch.
- [x] P0 optional log metadata: absent undefined fields omitted before rendering, preserving real messages, false/zero/null and literal text.
- [x] P0 conservative submission handling: pre-dispatch input refusal distinguished from usable returned task identity and post-dispatch outcome unknown; no automatic resubmission or unrelated-task inference.

#### Verification backlog — pending; perform later

- [ ] Re-run affected unit/build/Creator-load checks on the selected final artifact and record exact commit/builtAt.
- [ ] Creator build settings/profile/template persistence and reload; disposable web-mobile end-to-end and Android artifact qualification.
- [ ] Prefab positive/conflict/negative cases, native source/instance save-reopen and cleanup.
- [ ] Combined UI/Status/original responsive UUID and popup acceptance; exact current CCP discovery/handshake/restart/rollback/package verification.
- [ ] Protected migration/enrollment/signing/live workflows and fresh parity/evidence hashes under current CCP contracts.
- [ ] Verify native `builder/add-task` result/refusal semantics and task identity on the exact Creator artifact; current source treats all non-ID responses, including false/null, as outcome unknown until the native contract is evidenced.

Native config/preflight/environment routes and tween static remain development backlog. P0 source behavior is implemented; native submission semantics, regression suites and Creator/E2E qualification remain pending. Existing held/deferred API lanes and portfolio thresholds are unchanged.


### CCP source cutover and current release gates — 2026-10-09

- [x] Apply final active CCP naming across API3x/protected3x/2x/Gateway source and callers; preserve immutable historical signed evidence and frozen portfolio inputs.
- [x] Verify source artifacts: API build/Creator-load and unit 671/671; protected build/unit 258/258; 2x build/unit 117/117; Gateway typecheck/tests 83/83. Isolated project-bound HTTP/CLI smoke and Compose config pass; these are not installed Creator release witnesses.
- [ ] Review/migrate exact owned legacy package/profile/config/state without dual loading; preserve signed legacy bytes as archive only. Protected CCP requires fresh authorized product credentials/enrollment and a clean signed `ccp3x` release.
- [ ] Repeat exact current CCP package discovery/project-instance binding, persistence/reload, restart/rollback and selected Creator3.7 workflow witnesses; update current manifests/evidence hashes without relabeling old signatures or changing frozen thresholds. R1/R3/tilemap/3.8 lanes remain held.


## 1. Freeze and evidence

- [x] Ghi snapshot hash-reference trong `freeze-evidence.json`: `docs/tool-portfolio-candidates.json` (80+22=102, qualified 68) + `reports/api-capability-probe-20260920.json` + `reports/api-capability-preview-disabled-reconciliation-20260920.json` + backlog, tất cả bind với commit `bacd213`.
- [x] Giữ `api-capability-resume` ở `status: pending`; `node scripts/audit-tool-portfolio.js` hiện pass với `potentiallyQualifiable 73`, `approvedCount 70`, `requiredApprovalCount 82`, `marginEroded:true`. Change không sửa threshold hay portfolio state; `--require-ready` vẫn phải fail cho publish gate.
- [x] Trace smoke freeze `bacd213` ngày 2026-09-21: commit tồn tại; claim `10/10 pass`, scene open, handshake responsive được giữ trong `proposal.md`, `design.md`, `docs/tool-catalog.md`, và `freeze-evidence.json`. Không có transcript live độc lập để nâng thành witness mới.

## 2. Resume lanes (mở khi a quay lại — mỗi lane là một spec riêng)

- [x] **Lane R1 — Runtime/Game View foundation:** actual GAME_VIEW start/attach/state/pause/step/resume/time-scale/stop/reset transport, target-change fail-closed recovery and20-cycle regression evidence implemented. Final disposable Creator3.7.3 exact artifact smoke passed saved-scene start/control/stop; evidence `reports/game-view-final-qualification-20261011.json`. Owner gameplay project still has startup20s/teardown errors outside CCP; component playback remains unqualified.
- [ ] **Lane R2 — Project/Scene globals:** Creator3.8.8 project writer design-resolution/physics-gravity readback/restore qualified in `reports/creator38-api-wave-20261012.json`; Creator3.7 remains blocked at `project/set-config`/`_globals`. No portfolio promotion.
- [ ] **Lane R3 — Verification bundles:** bundle/runtime metadata contracts implemented with exact identity/ownership guards; localization public fixture and bundle-positive qualification now pass on Creator3.8.8 where official package/resource and assets exist. Creator3.7 original missing-resource/zero-assets blocker remains; no portfolio promotion.
- [ ] **Lane R4 — Selected prefab/tween follow-through:** prefab/tween static and R1 runtime foundation complete; tween runtime binding/control, tilemap source/import, and component runtime are separately bounded. No native variant/tween asset claim.
- [x] **Lane R5 — Engine features 3.8 bounded scope:** Creator3.8.8 terrain mutation/readback/restore and public light-probe bake start/inspect/cancel/persistence/foreign/overlap guards qualified; finite SH coefficients/output/topology/cleanup verified. Particle semantic writes, broader lightmap ownership and 3.7 engine APIs remain unqualified. No promotion.
- [x] **Lane R6 — Creator popup observability/control implementation** — owner accepted implementation-only closure on 2026-10-04. Detection plan `4-done-260922__261004-creator-popup-detection` and action child `4-done-260923__260925-creator-popup-actions` are complete. Live qualification is separately queued in vault plan `4-done-261004__261011-creator-popup-live-qualification` for combined feature testing; clean canonical Scene Not Response, stacked public-action reliability and cleanup remain pending. No portfolio promotion or parent resume closure.

### CCP-only runtime follow-through — 2026-10-11

- [x] Promptly report actual-versus-expected runtime scene drift with `RUNTIME_TARGET_CHANGED`; do not wait out readiness timeout or bind a stale scene handle.
- [x] **Runtime target recovery:** target mismatch returns `RUNTIME_TARGET_CHANGED` immediately with actual scene, no blind redispatch; focused runtime transport/session controls24/24 and final full suite703/703 pass. Owner gameplay startup/teardown failures are outside CCP scope and remain explicitly disclosed.
- [x] **Current runtime status reconciliation:** final full703/703 and focused24/24 pass; `reports/game-view-current-runtime-status-20261011.json` records implemented-but-unqualified component/tween runtime additions, owner-project partial failures and held lanes. No gameplay fix or portfolio promotion.
- [x] **Local API wave evidence 2026-10-12:** Creator3.8.8 project writer readback/restore, official localization fixture, bounded TMX source/import/validation, hierarchy paging/revision, Terrain mutation/readback/restore, data-only bundle lifecycle and bounded public light-bake start/inspect/cancel/persistence/foreign/overlap guards recorded. Current build/Creator-load and focused45/45 pass; no portfolio promotion.
- [x] **Bounded native closure:** Creator3.8.8 light-probe bake public adapter has owned finite job lifecycle and persistence evidence; particle editor `enabled` off/on readback is verified, while curve persistence/runtime playback and ParticleSystem2D remain unqualified. Creator3.7 missing localization/bundle resources and broader component/version routes remain separate. Protected release/signing separate.

### Final missing-gap audit — 2026-10-12

- Current audit passes: **342 registered**, approved70/required82, readiness false; workflow356/356 freeze-eligible; authoring228/247 at92.31%; historical/current hashes unchanged. No portfolio promotion.
- Bounded Creator3.8.8 evidence is complete for project writer, terrain, official localization fixture, TMX source/import, hierarchy revision paging, data-only bundle lifecycle and public light-probe bake/persistence/cancel/foreign/overlap guards. Particle semantic evidence is limited to editor `enabled` readback; curve persistence after reopen lacked a usable fixture identity, so no persistence/runtime claim.
- Current full unit suite **716/716**, Creator-load pass. Remaining release blockers are protected enrollment/signing/publish, physical-device/runtime component qualification, Creator3.7 missing resources, and any future portfolio decision. Parent remains HOLD; use a new lane proposal for further work.

### Final bounded continuation audit — 2026-10-12

- Current audit: 342 registered, approved70/required82, readiness false; workflow356/356 freeze-eligible; authoring228/247=92.31%; full unit716/716. Historical/current hashes unchanged.
- Remaining boundaries are particle curve persistence/runtime playback/ParticleSystem2D, Creator3.7 localization/bundle resource absence, material mutation readback, preview resolution, bitmap-font writes and graph semantic/runtime validity. Protected enrollment/signing/publish and physical-device runtime remain separate.
- Parent remains HOLD by policy. Further work requires a new lane proposal with exact fixture/artifact and positive/negative witnesses; no silent candidate promotion or threshold changes.

### Build/config priority — owner decision 2026-10-08

- Owner approved development of build configuration, settings and reusable profiles. This does not reopen project/scene globals, Game View, tilemap, bundle/localization or engine-feature qualification.
- Implemented `buildSettingsManage` for allowlisted Creator builder local/global defaults and cache preferences; writes verify read-back and rollback. No changes to existing tasks, SDK/NDK or signing credentials.
- Implemented `buildProfileManage` for CCP-owned project profiles (list/get/save/delete), audited options, credential refusal, bounded storage and guarded writes. These are not native Creator build preset assets.
- Implemented `buildTemplate` list/create for six platforms and debug/release options; scene identity syntax/start-scene membership/native package ID are validated, target settings use packages[platform], and nested target profile validation rejects incompatible option types. Templates never persist/dispatch and disclose missing asset/toolchain/signing qualification.
- Offline build and HTTP persistence smoke use a simulated Creator Profile backend; real Creator persistence/reload and exact build artifact qualification remain pending. No portfolio promotion or threshold changes.
- P0 source follow-through implemented: safe ID normalization, undefined metadata omission and conservative submission outcome reporting. Pending separately: native `add-task` semantics/live task-ID proof, native task/preset settings route and Android environment configuration after authoritative discovery. Do not retry ambiguous submission.

### Approved delivery sequence — 2026-10-08

- [x] **P0 task identity implementation/verification:** safe numeric/string IDs normalized; unit684/684 and native exact-ID get/control/wait lifecycle verified.
- [x] **P0 logging implementation/verification:** undefined optional metadata omitted without suppressing errors; full regression suite pass.
- [x] **P0 submission implementation/verification:** native add-task false is outcome-unknown; exact caller-ID queue reconciliation followed terminal success without resubmission on clean827848c package.
- [x] **Build config/preflight:** authoritative scene/target/bundle/server checks and guarded terminal native task update/read-back/restoration implemented and exercised; in-memory only persisted:false, no native preset/history persistence claim.
- [x] **Environment inspection:** registered SDK/NDK read-back and paths redacted; actual r21e/API34/JDK8-scoped Android Make succeeded. Java registration remains unsupported while process JDK is explicit; no environment writes/signing secrets.
- [x] **Clean-package web-mobile E2E:** committed827848c ZIP, profile persistence/restart previously proven, explicit exact-ID submission/queue reconciliation, success7226ms, output and cleanup. Evidence `reports/android-clean-package-qualification-20261011.json` plus package lifecycle report.
- [x] **Disposable technical web-mobile E2E:** profile persistence/restart, explicit task identity/reconciliation, success/output and cleanup observed on copied dirty artifact. This does not tick the clean packaged-artifact requirement above.
- [x] **Prefab closure:** mounted/removed/nested native public-tool replay, conflict/source diff/byte bound/save-reopen/cleanup pass on clean827848c package. Technical regression report plus final `reports/android-clean-package-qualification-20261011.json`; no variant asset/portfolio promotion.
- [x] **Tween static implementation:** registered project-code create/inspect/static diagnostics, explicit new-source ownership, bounds/conflict/read-back and deterministic negatives. Focused boundaries and full unit suite pass; generated Inspector target binding/runtime/installed-artifact qualification remain unproven. Runtime stays pending under R1.
- [x] **Android debug artifact qualification:** clean827848c package; Creator generation25417ms, JDK8-scoped Gradle assembleDebug success2m26s/79 tasks, actual24,639,102-byte arm64-v8a debug APK manifest com.ccp.qualification/API34 verified and SHA256 recorded. Cleanup complete. No physical-device/iOS/release-signing claim.
- [x] **Combined UI/observability — owner verified:** owner confirmed Status and popup checked OK and explicitly requested DONE on 2026-10-11. Accepted as owner verification; no agent rerun or invented canonical witness IDs, artifact signatures or portfolio promotion.
- [x] **Current evidence reconciliation:** duplicate prefab overrides resolved, exact current routes corrected, current full 237/356 and authoring 228/247 (92.31%) audits pass. Historical full228/later236 and authoring223 remain historical; approved denominator IDs are distinct from reproducible current semantic hashes. No threshold or portfolio promotion.
- [x] **API package qualification:** clean827848c ZIP install/discovery/handshake/profile restart/owned rollback, clean web build and public mounted/removed/nested prefab replay with2048-byte cap/save-reopen pass. API delivery scope complete. Publishing/protected signing/minifier remain separate plans, not implied release permission.
- [x] **API package lifecycle smoke:** committed827848c dirtyfalse ZIP extracted with real dependencies into disposable project; registered preflight/prefab byte contract, profile persistence after Creator restart and exact project handshake pass. Owned previous artifact rollback also responsive; fixtures cleaned and owned Creator stopped. Evidence `reports/api-package-qualification-20261011.json`. Full selected-platform packaged workflows/protected release remain separate; no push/signing claim.

Execution order: build/log P0 → native build config/preflight → web-mobile end-to-end → prefab live closure → tween static → Android qualification → package/release. Evidence reconciliation accompanies each phase. R1 pending, R3/tilemap deferred, R5 consideration only; no automatic reopening of 3.8 breadth.

### Selected Creator3.7 API delivery closure — 2026-10-11

All nine selected delivery items are complete at their stated API/debug scope. Clean-package public prefab mounted/removed/nested replay passed (1539/1757/1809-byte responses at2048 cap), nested source link retained, Widget removed and save/reopen confirmed. Android APK SHA256 `5191590993aa1e64721a21445493c927e601990cdd33f74422ad9a799eed8c42`; preserved at `reports/artifacts/qualificationandroid-827848c-debug.apk`. Task/profile counts0, fixtures/build/native outputs removed, owned Creator stopped. Current source regression/audit evidence and reports are separate from frozen portfolio qualification; no threshold/promotion. The parent future-breadth inventory stays pending/HOLD by its original contract; selected3.7 completion does not reopen or falsely close R1/R3/tilemap/3.8, protected release or publish.

### Follow-through checkpoint — 2026-10-11

Evidence: `reports/api-capability-follow-through-20261011.json`. TypeScript compile and Creator-load pass; unit 683/683, reconciliation regressions 6/6, both coverage audits and portfolio audit pass. Current registration is 335, approved70/required82; bulk readiness remains false. Current coverage is reconciled implementation evidence, not fresh installed Creator qualification.

Initial read-only probe used owner project loaded dirty72c3bc3 without mutation. Owner then explicitly approved a separate disposable project. Copied dirty API artifact with dependency junction was installed there (not clean packaged release), bound and restarted. Profile save/get survives Creator process restart; one explicit web-mobile submission returned outcome-unknown but exact caller taskId appeared once and reached success in30453ms, with index.html and expected output tree. No retry. Terminal task debug update/read-back/restoration passed installed API after typed native option compatibility fix. Tween create/inspect/static/runtime-unavailable and prefab active override/source hash/conflict/save/reopen/restart passed. References refreshed after restart; source/scene/tween/profile/task/output cleanup confirmed, owned Creator stopped. `sceneManage close` returned SCENE_CLOSE_UNCONFIRMED; no false close credit. Clean artifact, mounted/removed/nested prefab bounds, combined UI/popup, Android toolchain and release rollback/signatures remain pending; future breadth HOLD.

## Deferred hierarchy browsing — owner idea, not a release gate

- [ ] Sau release Creator 3.7, thiết kế bounded `nodeGetTree` browsing: giữ mặc định depth 4 / 200 nodes (không mở depth vô hạn); khi `truncated`, agent dùng `reference` để đọc tiếp nhánh cần thiết. Với cha rộng, cân nhắc `childOffset` + `pageSize`, trả `childrenCount` và `nextOffset`/end-of-page; giới hạn từng request và không auto-fetch toàn scene. Chốt thứ tự children và semantics khi scene đổi giữa các trang; chứng minh kết quả trên fixture sâu/rộng và đo payload/token trước khi implement. Không tính vào qualification hay publish gate hiện tại.

## 3. Re-entry checklist (khi a bảo "back lại")

- [ ] Chọn lane, tạo proposal riêng từ change này, bump `requiredApprovalCount` nếu potřeba qua decision ghi file, không hạ lén.
- [ ] Chạy `reports/api-capability-probe-20260920.json` pattern probe mới trên artifact không dirty, ghi commit `builtAt` vào evidence.
- [ ] Mỗi row promote phải có `reports/evidence/candidates/<name>/<creator>-<sha>.json` + `positiveTestID/negativeTestID` pass, rồi mới đổi `candidate → qualified` trong `docs/tool-portfolio-candidates.json`.
