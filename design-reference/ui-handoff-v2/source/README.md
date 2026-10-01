# Email operations workspace UI

React 19 + TypeScript web prototype chạy bằng Vite/Vinext.

## Yêu cầu

- Node.js `>=22.13.0`
- npm đi kèm Node.js

## Development

```bash
npm ci
npm run dev
```

Mở `http://localhost:5173`.

## Production preview

```bash
npm run build
npm run start
```

Mở `http://localhost:3000`.

Các script không dùng cú pháp biến môi trường Unix hoặc Bash nên có thể chạy trực tiếp trong PowerShell, Command Prompt, Terminal macOS và Linux.

## Kiểm tra

```bash
npm run lint
npm test
```

Đây là prototype UI dùng dữ liệu mẫu và `localStorage`; các thao tác gửi email, SMTP, import, xác thực và realtime vẫn cần nối backend thật.
