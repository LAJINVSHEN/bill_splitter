@echo off
setlocal
cd /d "%~dp0"

REM even - local dev: Postgres 16 + API in Docker, web app via Vite.

where docker >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH. Install/start Docker Desktop.
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js/npm not found. Install Node 22+.
    pause
    exit /b 1
)

echo [INFO] Starting database and API (docker compose)...
docker compose up -d --build db api
if errorlevel 1 (
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)

echo [INFO] Waiting for the API...
timeout /t 6 /nobreak >nul

echo [INFO] Loading sample data (safe to re-run)...
docker compose exec -T api python -m app.cli dev-seed

if not exist "web\node_modules" (
    echo [INFO] Installing web dependencies...
    pushd web
    call npm install
    popd
)

echo [INFO] Starting the web app in a new window...
start "even web" cmd /k "cd /d %~dp0web && npm run dev"

echo.
echo [READY] Open http://localhost:5173
echo         Sign in as: george  (admin)  or maya / arjun / lena / tomas
echo         Password:   the DEV_LOGIN_PASSWORD value in the root .env file
echo         API docs:   http://localhost:8000/docs     Logs: docker compose logs -f api
echo.
endlocal
pause
