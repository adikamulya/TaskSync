# Beranda Harian & Tugas

Halaman beranda pribadi (cuaca, tautan cepat, tugas) yang tugasnya tersinkron dua arah dengan Google Tasks.
Tugas dari LMS Telkom University masuk ke Google Tasks lewat userscript, lalu tampil di halaman ini.

## Isi repo
- `index.html` : halaman beranda (disajikan lewat GitHub Pages)
- `userscript/lms-google-tasks.user.js` : userscript Tampermonkey (sync LMS -> Google Tasks, dan beranda <-> Google Tasks)

## Pasang
1. Aktifkan GitHub Pages: Settings -> Pages -> Source: `main` / root.
2. Buka `https://USERNAME.github.io/REPO/`.
3. Pasang userscript di Tampermonkey, lalu ganti `USERNAME` dan `REPO` di baris `@match` dan `BERANDA_PREFIX`.
4. Login Google lewat tombol di pojok kanan bawah.
5. Opsional: di Chrome/Edge pilih menu -> Save and share -> Install page as app.

## Keamanan
- **Jangan commit `CLIENT_SECRET`.** Isi hanya di salinan lokal Tampermonkey. Salinan berakhiran `.local.js` diabaikan git.
- Data tugas disimpan di `localStorage` browser kamu, bukan di repo.
