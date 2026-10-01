export const recipientTags = [
  { name: "Nhân viên mới", count: 24, color: "#ef6f45" },
  { name: "Quản lý", count: 16, color: "#7356c8" },
  { name: "Nội bộ", count: 312, color: "#278b6e" },
  { name: "Ưu tiên", count: 86, color: "#d79022" },
  { name: "Marketing", count: 42, color: "#3a78c2" },
  { name: "Hà Nội", count: 174, color: "#9a5eb0" },
  { name: "Đã xác minh", count: 468, color: "#31806b" },
  { name: "Khách hàng", count: 220, color: "#b85b73" },
] as const;

export const recipientLists = [
  { name: "Danh sách nhân viên", count: 128, valid: 128, updated: "Hôm nay · 09:42", source: "Thêm thủ công & Excel" },
  { name: "Nhân viên mới tháng 08", count: 24, valid: 24, updated: "Hôm nay · 08:15", source: "Tag Nhân viên mới" },
  { name: "Quản lý phòng ban", count: 16, valid: 16, updated: "05/08/2026", source: "Tạo thủ công" },
  { name: "Khách hàng ưu tiên", count: 86, valid: 82, updated: "02/08/2026", source: "Import Excel" },
] as const;

export const recipientImports = [
  { file: "employees_august.xlsx", rows: 128, valid: 124, invalid: 4, date: "06/08/2026 · 10:24", status: "Cần kiểm tra" },
  { file: "priority_customers.xlsx", rows: 86, valid: 86, invalid: 0, date: "02/08/2026 · 14:08", status: "Hoàn tất" },
  { file: "internal_contacts.csv", rows: 312, valid: 312, invalid: 0, date: "28/07/2026 · 09:30", status: "Hoàn tất" },
] as const;
