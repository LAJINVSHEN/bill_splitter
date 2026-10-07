@echo off
setlocal

set BACKEND_DIR=backend
set FRONTEND_DIR=frontend

REM ---- CHECK DOCKER (backend + Postgres 16 run in docker compose) ----
where docker >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH. Install/start Docker Desktop.
    exit /b 1
)

REM ---- CHECK IF DIRECTORIES EXIST ----
if not exist "%BACKEND_DIR%" (
    echo [ERROR] Backend directory not found: %BACKEND_DIR%
    echo Please run set-up-windows.cmd first.
    exit /b 1
)

if not exist "%FRONTEND_DIR%" (
    echo [ERROR] Frontend directory not found: %FRONTEND_DIR%
    echo Please run set-up-windows.cmd first.
    exit /b 1
)

REM ---- CHECK IF NODE_MODULES EXISTS ----
if not exist "%FRONTEND_DIR%\node_modules" (
    echo [ERROR] Frontend dependencies not installed.
    echo Please run set-up-windows.cmd first.
    exit /b 1
)

REM ---- START BACKEND (Postgres 16 + API, migrations run on start) ----
echo [INFO] Starting database and backend (docker compose)...
docker compose up -d --build db api
if errorlevel 1 (
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    exit /b 1
)

REM ---- WAIT A MOMENT FOR BACKEND TO START ----
timeout /t 5 /nobreak >nul

REM ---- START FRONTEND ----
echo [INFO] Starting frontend server...
start "Bill Splitter Frontend" cmd /k "cd %FRONTEND_DIR% && npm run dev"

echo.
echo [SUCCESS] Backend is running in Docker; the frontend is starting in a new window.
echo [INFO] Backend: http://localhost:8000  (logs: docker compose logs -f api)
echo [INFO] Frontend: http://localhost:5173
echo.
echo [TIP] Wait for both servers to fully start before using the app.
echo [TIP] Check the terminal windows for any error messages.

endlocal
pause
