/**
 * `import type` on purpose -- it is erased at build time, so `exceljs` is not a
 * static dependency of this module.
 *
 * Measured 2026-09-11: the static `import ExcelJS from 'exceljs'` that used to
 * be here pulled the whole library into the main chunk, because
 * `ImportRecipientsOverlay.tsx:7` imports this module eagerly for
 * `downloadRecipientXlsxSample`. The other exceljs caller
 * (`spreadsheet-import.ts`) was already behind a dynamic `import()` at the call
 * site and cost nothing; this one was not, so every visitor downloaded a
 * spreadsheet writer to look at a list of recipients.
 *
 * The module itself stays a normal static import -- it is a few constants and
 * a function. Only the library is deferred, to the moment someone actually
 * asks for the sample file.
 */
import type ExcelJS from 'exceljs';

export const RECIPIENT_SAMPLE_FILENAME = 'eow-recipients-import-template-v1.xlsx';
export const RECIPIENT_SAMPLE_HEADERS = ['email', 'first_name', 'last_name', 'department', 'list', 'tag'];
export const RECIPIENT_SAMPLE_ROWS = [
  ['an@example.test', 'Minh An', 'Nguyễn', 'Marketing', 'Khách hàng', 'newsletter'],
  ['ha@example.test', 'Thu Hà', 'Trần', 'Sales', 'Đối tác', 'event-2026'],
];

const INSTRUCTIONS = [
  ['EMAIL OPERATIONS WORKSPACE — FILE IMPORT NGƯỜI NHẬN', ''],
  ['Phiên bản mẫu', 'v1'],
  ['Định dạng', 'XLSX hoặc CSV UTF-8; tối đa 50 MB và 100.000 dòng dữ liệu.'],
  ['Sheet dữ liệu', 'Giữ sheet Nguoi_nhan là sheet đầu tiên. Không đổi hàng tiêu đề số 1.'],
  ['email', 'Bắt buộc. Mỗi dòng phải có một địa chỉ email hợp lệ.'],
  ['first_name', 'Không bắt buộc. Tên gọi của người nhận.'],
  ['last_name', 'Không bắt buộc. Họ của người nhận.'],
  ['department', 'Ví dụ trường tùy chỉnh. Tạo key department tại Cài đặt > Trường tùy chỉnh trước khi mapping.'],
  ['list', 'Không bắt buộc. Một tên danh sách đã tồn tại cho mỗi ô.'],
  ['tag', 'Không bắt buộc. Một tên tag đã tồn tại cho mỗi ô.'],
  ['Mapping', 'Ở bước 2, kiểm tra lại cột nguồn được map vào email, tên, họ, danh sách, tag và trường tùy chỉnh.'],
  ['Chế độ mặc định', 'Upsert: tạo mới nếu email chưa tồn tại, cập nhật nếu đã tồn tại.'],
  ['Dòng mẫu', 'Có thể xóa hai dòng mẫu trước khi nhập dữ liệu thật.'],
  ['Lưu ý', 'Không thêm công thức, macro hoặc dữ liệu bí mật vào file import.'],
];

export async function buildRecipientSampleWorkbook(): Promise<ExcelJS.Workbook> {
  const { default: Excel } = await import('exceljs');
  const workbook = new Excel.Workbook();
  workbook.creator = 'Email Operations Workspace';
  workbook.subject = 'Recipient import template v1';
  workbook.description = 'Standard recipient import template with mapping guidance.';

  const dataSheet = workbook.addWorksheet('Nguoi_nhan', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 20 },
  });
  dataSheet.addRow(RECIPIENT_SAMPLE_HEADERS);
  RECIPIENT_SAMPLE_ROWS.forEach((row) => dataSheet.addRow(row));
  dataSheet.autoFilter = { from: 'A1', to: 'F3' };
  dataSheet.getRow(1).height = 24;
  dataSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  dataSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C442B' } };
  dataSheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  dataSheet.columns = [
    { key: 'email', width: 32 }, { key: 'first_name', width: 20 }, { key: 'last_name', width: 18 },
    { key: 'department', width: 22 }, { key: 'list', width: 24 }, { key: 'tag', width: 22 },
  ];
  dataSheet.getColumn(1).eachCell((cell, rowNumber) => { if (rowNumber > 1) cell.numFmt = '@'; });
  const guideSheet = workbook.addWorksheet('Huong_dan', { views: [{ state: 'frozen', ySplit: 2 }] });
  INSTRUCTIONS.forEach((row) => guideSheet.addRow(row));
  guideSheet.mergeCells('A1:B1');
  guideSheet.getRow(1).height = 30;
  guideSheet.getRow(1).font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  guideSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9C442B' } };
  guideSheet.getRow(1).alignment = { vertical: 'middle' };
  guideSheet.getColumn(1).width = 24;
  guideSheet.getColumn(2).width = 88;
  guideSheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber > 1) {
      row.getCell(1).font = { bold: true, color: { argb: 'FF5D3125' } };
      if (rowNumber % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7F2' } };
    }
  });
  return workbook;
}

export async function downloadRecipientXlsxSample(): Promise<void> {
  const workbook = await buildRecipientSampleWorkbook();
  const buffer = await workbook.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = RECIPIENT_SAMPLE_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
}
