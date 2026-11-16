set dotenv-load

# Package the desktop app into dist/ for this OS, or for others: just build --win --linux
build *targets:
    npx electron-builder {{targets}}
