# Start coding with an agent

## One-time preparation

From the repository root:

```bash
python scripts/ui_handoff.py install /path/to/email-operations-workspace-ui-handoff-v2.zip
python scripts/ui_handoff.py status
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

If the UI was copied manually, run `python scripts/ui_handoff.py register` before `status`.

## Approval prompt

```text
Tôi phê duyệt bắt đầu triển khai Email Operations Workspace.

Hãy đọc AGENTS.md và thực hiện theo autonomous delivery contract của repository.
Đây là START gate cho các milestone đã định nghĩa trong docs/00-start-here.md.

UI Source of Truth đã được đặt tại:
design-reference/ui-handoff-v2/source/

Trước khi code frontend, hãy chạy python scripts/ui_handoff.py status, lập inventory route,
screen, component, modal, state, asset, mock data, mock action và dependency. Dùng UI handoff
làm chuẩn trình bày/tương tác; dùng catalog/ba-rules.json làm chuẩn hành vi. Không tự thiết kế
lại màn hình đã duyệt.

Hãy tạo run-state, lập Agent Graph theo dependency, chạy bounded Agent Loop trong từng node,
tự triển khai từng vertical slice, kiểm thử, tự sửa và cập nhật traceability. Không hỏi lại
cho các quyết định kỹ thuật thường lệ. Chỉ dừng tại STOP gate trong AGENTS.md.

Chỉ báo completed khi rule → contract → code → test → observability đã khép kín, UI đã được
đối chiếu ở các viewport bắt buộc, mock trong phạm vi đã được thay bằng tích hợp thật, toàn bộ
typecheck/test/build/deployment validation đạt và completion report có đủ bằng chứng.
```

The agent may tailor or skip irrelevant graph nodes, but it must not bypass `ui_intake` when
the approved scope includes frontend or visual behavior.
