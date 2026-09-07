# ⚡ AI Code Diff Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/mamadfakoor/ai-code-diff-assistant/main/icon.png" alt="AI Code Diff Assistant" width="128" height="128">
</p>

<p align="center">
  <strong>پل ارتباطی بین AI Playgroundها و کد واقعی پروژه شما در VS Code</strong>
</p>

<p align="center">
  <a href="#-ویژگیها">ویژگی‌ها</a> •
  <a href="#-نحوه-استفاده">نحوه استفاده</a> •
  <a href="#-فرمت-پچها">فرمت پچ‌ها</a> •
  <a href="#️-تنظیمات">تنظیمات</a> •
  <a href="#-دستورات">دستورات</a>
</p>

---

## 💡 AI Code Diff Assistant چیست؟

**AI Code Diff Assistant** یک افزونه برای **VS Code** است که به شما اجازه می‌دهد بدون نیاز به اشتراک‌های گران‌قیمت ابزارهایی مثل Cursor، از AI Playgroundهای مختلف برای تحلیل و تغییر کد پروژه استفاده کنید.

افزونه، **ساختار و سورس پروژه را به یک Context استاندارد تبدیل می‌کند**، آن را برای استفاده در سرویس‌های AI آماده می‌کند و سپس پاسخ AI را به‌صورت **Patch** روی فایل‌های پروژه اعمال می‌کند.

### 🔄 Workflow

```text
┌──────────────────────┐
│   📁 VS Code Project │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  📋 Copy AI Context  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   🤖 AI Playground   │
│ Gemini / DeepSeek /  │
│ OpenAI / Claude / …  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   🚀 Apply AI Patch  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    ✨ Updated Code   │
└──────────────────────┘
```

---

## ✨ ویژگی‌ها

- 🌳 **Project Context کامل** — ساختار درختی پروژه و محتوای فایل‌ها را به یک Prompt استاندارد و شماره‌گذاری‌شده تبدیل می‌کند.
- 📁 **انتخاب پوشه‌ها** — می‌توانید فقط بخش‌های موردنظر پروژه را برای AI ارسال کنید.
- 🧩 **Smart Diff Patching** — پاسخ AI را به تغییرات واقعی روی فایل‌ها تبدیل می‌کند.
- 🔍 **SEARCH / REPLACE** — پشتیبانی از روش مبتنی بر جست‌وجو و جایگزینی، با تطبیق هوشمند Whitespace و Indentation.
- 📌 **Line Operations** — پشتیبانی از عملیات `INSERT_AFTER`، `INSERT_BEFORE`، `REPLACE` و `DELETE`.
- 🆕 **ساخت فایل جدید** — ایجاد خودکار فایل با استفاده از `// NEW FILE`.
- 🛡️ **کنترل کامل تغییرات** — فایل‌های تغییرکرده مستقیماً در ادیتور باز می‌شوند تا قبل از ذخیره آن‌ها را بررسی کنید.
- 📋 **Clipboard Friendly** — دریافت و ارسال Context و Patch از طریق Clipboard.
- 🧭 **Sidebar اختصاصی** — دسترسی سریع به قابلیت‌های اصلی افزونه.
- 🚫 **Exclude هوشمند** — امکان نادیده‌گرفتن فایل‌ها و پوشه‌های غیرضروری مانند `node_modules`، فایل‌های باینری، تصاویر، لاگ‌ها و Lockfileها.
- ⌨️ **Command Palette** — تمام عملیات اصلی از طریق Command Palette نیز در دسترس هستند.

---

## 🚀 نحوه استفاده

### 1. 📋 ساخت Context پروژه

1. سایدبار **AI Diff Assistant** را از نوار کناری VS Code باز کنید.
2. پوشه‌هایی را که می‌خواهید AI به آن‌ها دسترسی داشته باشد انتخاب کنید.
3. روی **Copy Prompt + Structure + Source Code** کلیک کنید.

حالا Context پروژه در Clipboard شما قرار دارد.

### 2. 🤖 گفتگو با AI

Context کپی‌شده را در AI Playground موردنظر Paste کنید و درخواست خود را بنویسید.

برای مثال:

```text
تابع احراز هویت را به src/auth.ts اضافه کن
```

AI باید تغییرات موردنیاز را در یکی از فرمت‌های Patch پشتیبانی‌شده برگرداند.

### 3. 🚀 اعمال تغییرات

پاسخ AI را Copy کنید و:

- آن را در بخش Patch افزونه Paste کنید و روی **Apply Smart Changes** کلیک کنید.

یا:

- `Ctrl + Shift + P` را بزنید.
- دستور **AI Assistant: Apply AI Code Response** را اجرا کنید.

> 💡 تغییرات مستقیماً در فایل‌ها اعمال می‌شوند، اما برای کنترل بیشتر می‌توانید آن‌ها را قبل از ذخیره در VS Code بررسی کنید.

---

## 🧩 فرمت Patchها

افزونه چند نوع Patch را به‌صورت خودکار تشخیص می‌دهد.

### 1. SEARCH / REPLACE

فرمت پیشنهادی و پیش‌فرض:

```text
// FILE: src/user.ts

<<<<<<< SEARCH
export function getUser(id: string) {
    return db.users.find(id);
}
=======
export async function getUser(id: string) {
    const user = await db.users.find(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
}
>>>>>>> REPLACE
```

این روش برای تغییر بخش مشخصی از کد مناسب است و افزونه امکان تطبیق Whitespace و Indentation را نیز دارد.

### 2. Line Operations

برای تغییر بر اساس شماره خطوط:

```text
// FILE: src/utils/math.ts
// REPLACE: 12-15

function add(a: number, b: number): number {
    return a + b;
}
```

عملیات پشتیبانی‌شده:

- `INSERT_AFTER`
- `INSERT_BEFORE`
- `REPLACE: X-Y`
- `DELETE`

### 3. ایجاد فایل جدید

برای ساخت یک فایل جدید:

```text
// FILE: src/types/config.ts
// NEW FILE

export interface AppConfig {
    port: number;
    host: string;
}
```

---

## ⚙️ تنظیمات

تنظیمات افزونه از بخش **VS Code Settings** قابل شخصی‌سازی هستند.

| Setting | Default | توضیحات |
|---|---|---|
| `aiDiffAssistant.excludeFolders` | `[]` + موارد پیش‌فرض | پوشه‌هایی که نباید وارد Context شوند |
| `aiDiffAssistant.excludeFiles` | `[]` + موارد پیش‌فرض | الگوهای فایل‌هایی که باید حذف شوند |

### 📦 مواردی که معمولاً Exclude می‌شوند

```text
node_modules/
.git/
dist/
out/

*.log
*.lock
*.png
```

این کار باعث می‌شود Context نهایی کوچک‌تر و کاربردی‌تر باشد.

---

## ⌨️ دستورات

تمام قابلیت‌های اصلی از طریق **Command Palette** (`Ctrl + Shift + P`) در دسترس هستند:

| Command | کاربرد |
|---|---|
| `AI Assistant: Copy Project Context & System Prompt` | کپی Context، ساختار پروژه و System Prompt |
| `AI Assistant: Copy Project Structure Only` | کپی فقط ساختار درختی پروژه |
| `AI Assistant: Apply AI Code Response` | اعمال Patch دریافت‌شده از AI |

---

## 🤖 سازگار با AI Playgroundها

این افزونه وابسته به یک سرویس AI خاص نیست و می‌توانید Context آن را در سرویس‌های مختلف استفاده کنید، از جمله:

- Google AI Studio
- DeepSeek Playground
- OpenAI Playground
- Claude
- OpenRouter
- Hugging Face

> سرویس‌های بالا صرفاً نمونه‌هایی از محیط‌هایی هستند که می‌توان Context تولیدشده توسط افزونه را در آن‌ها استفاده کرد.

---

## 🔐 امنیت و کنترل

**AI Code Diff Assistant خودش تصمیم نمی‌گیرد که تغییرات را بدون کنترل شما ذخیره کند.**

تغییرات در ادیتور VS Code باز می‌شوند و شما می‌توانید:

- کد را بررسی کنید.
- تغییرات را اصلاح کنید.
- با `Ctrl + S` ذخیره کنید.
- با `Ctrl + Z` تغییرات را برگردانید.

> ⚠️ همیشه قبل از ذخیره تغییرات تولیدشده توسط AI، آن‌ها را بررسی کنید.

---

## 📄 License

این پروژه تحت **MIT License** منتشر شده است.

---

<p align="center">
  ⭐ اگر این پروژه برایتان مفید بود، خوشحال می‌شوم با یک Star از آن حمایت کنید.
</p>
