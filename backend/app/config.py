"""Application settings (pydantic-settings).

Values come from the process environment first, then the **repo-root** ``.env``
(``Path(__file__).parents[2] / ".env"``). Unknown keys are ignored so the same
``.env`` can also carry frontend / deploy variables.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env"


class ModelPrice(BaseModel):
    """USD per 1M tokens (equivalently: micro-USD per token)."""

    input: Decimal
    output: Decimal
    cached_input: Decimal | None = None


# Prices from OpenAI's model pages (checked 2026-10-07). Override with LLM_PRICES (JSON).
DEFAULT_LLM_PRICES: dict[str, ModelPrice] = {
    "gpt-6-luna": ModelPrice(input=Decimal("0.10"), cached_input=Decimal("0.01"), output=Decimal("0.50")),
    "gpt-6.1-sol": ModelPrice(input=Decimal("2.00"), cached_input=Decimal("0.10"), output=Decimal("10.00")),
    "gpt-6-astra": ModelPrice(input=Decimal("10.00"), cached_input=Decimal("1.00"), output=Decimal("50.00")),
    "gpt-5.4-mini": ModelPrice(input=Decimal("0.75"), cached_input=Decimal("0.075"), output=Decimal("4.50")),
    "gpt-4.1-mini": ModelPrice(input=Decimal("0.40"), cached_input=Decimal("0.10"), output=Decimal("1.60")),
    "gpt-4o-mini": ModelPrice(input=Decimal("0.15"), cached_input=Decimal("0.075"), output=Decimal("0.60")),
    "gpt-4o": ModelPrice(input=Decimal("2.50"), cached_input=Decimal("1.25"), output=Decimal("10.00")),
}

CommaList = Annotated[list[str], NoDecode]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- App -----------------------------------------------------------------
    app_name: str = "even"  # product name (API title, logs)
    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    app_timezone: str = "Asia/Singapore"
    default_currency: str = "SGD"
    public_app_url: str = ""
    render_git_commit: str = ""  # set by Render; reported by GET /api/health  # frontend origin used to build share URLs
    cors_origins: CommaList = Field(default_factory=lambda: ["http://localhost:3000"])

    # --- Database ------------------------------------------------------------
    database_url: str = "postgresql://postgres:postgres@localhost:5433/bill_splitter"
    db_pool_size: int = 5
    db_max_overflow: int = 5
    database_ssl: Literal["auto", "require", "disable"] = "auto"
    # auto = disable asyncpg prepared statements when the URL uses the transaction pooler (:6543)
    db_disable_prepared_statements: Literal["auto", "true", "false"] = "auto"

    # --- Supabase / auth -----------------------------------------------------
    supabase_url: str = ""
    supabase_jwt_secret: str = ""  # legacy HS256 secret (fallback when no JWKS key matches)
    supabase_service_role_key: str = ""  # service-role / sb_secret key (server only)
    supabase_admin_backend: Literal["supabase", "fake"] = "supabase"
    auth_email_domain: str = "users.even.app"
    # Dev-only login (/api/dev/auth/*, never mounted in production or with the real Supabase admin):
    # password accepted for users the in-memory fake admin doesn't know. Empty = reject.
    dev_login_password: str = ""
    jwt_audience: str = "authenticated"
    jwt_leeway_seconds: int = 30
    jwks_cache_seconds: int = 600

    # --- Azure Document Intelligence -----------------------------------------
    ocr_backend: Literal["azure", "fake"] = "azure"
    azure_di_endpoint: str = ""
    azure_di_key: str = ""
    ocr_max_concurrency: int = 2
    ocr_max_pdf_pages: int = 2  # F0 only analyses the first 2 pages of a PDF
    ocr_timeout_seconds: float = 90.0

    # --- LLM (OpenAI) --------------------------------------------------------
    llm_backend: Literal["openai", "fake"] = "openai"
    openai_api_key: str = ""
    llm_primary_model: str = "gpt-6-luna"
    llm_primary_reasoning_effort: str = "low"
    llm_fallback_model: str = "gpt-6.1-sol"
    llm_fallback_reasoning_effort: str = "low"
    llm_timeout_seconds: float = 60.0
    llm_max_retries: int = 1
    llm_max_output_tokens: int = 8000
    llm_prices: dict[str, ModelPrice] = Field(default_factory=lambda: dict(DEFAULT_LLM_PRICES))

    # --- Storage -------------------------------------------------------------
    storage_backend: Literal["local", "supabase"] = "local"
    storage_bucket: str = "receipts"
    local_storage_dir: str = str(REPO_ROOT / ".local" / "storage")
    signed_url_ttl_seconds: int = 300
    receipt_retention_days: int = 90

    # --- Scans / jobs --------------------------------------------------------
    scan_max_files: int = 5
    scan_max_file_bytes: int = 4 * 1024 * 1024  # F0 limit per file
    job_heartbeat_seconds: float = 10.0
    job_stale_seconds: float = 90.0

    # --- Quotas (seed values for the app_settings row) -----------------------
    default_user_monthly_quota: int = 30
    global_monthly_page_cap: int = 450
    global_monthly_llm_budget_usd: Decimal = Decimal("5")

    # --- Guardrails ----------------------------------------------------------
    rate_limit_enabled: bool = True
    rate_limit_default: str = "300/minute"
    rate_limit_scans: str = "10/minute;100/day"
    rate_limit_public: str = "30/minute"
    rate_limit_admin_create: str = "20/hour"
    max_json_body_bytes: int = 256 * 1024
    cron_secret: str = ""

    # ------------------------------------------------------------------------
    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip().rstrip("/") for o in v.split(",") if o.strip()]
        return v

    @field_validator("default_currency")
    @classmethod
    def _upper_currency(cls, v: str) -> str:
        from app.core.currencies import is_currency

        v = v.strip().upper()
        if not is_currency(v):
            raise ValueError("DEFAULT_CURRENCY must be an ISO 4217 code from shared/currencies.json")
        return v

    @field_validator("supabase_url", "public_app_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.strip().rstrip("/")

    # --- Derived -------------------------------------------------------------
    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def async_database_url(self) -> str:
        """postgresql:// → postgresql+asyncpg://, dropping libpq-only query params."""
        url = self.database_url.strip()
        for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
            if url.startswith(prefix):
                url = "postgresql+asyncpg://" + url[len(prefix):]
                break
        parts = urlsplit(url)
        query = [(k, v) for k, v in parse_qsl(parts.query) if k not in {"sslmode", "pgbouncer"}]
        return urlunsplit(parts._replace(query=urlencode(query)))

    @property
    def db_connect_args(self) -> dict[str, object]:
        args: dict[str, object] = {}
        host = urlsplit(self.database_url).hostname or ""
        ssl = self.database_ssl
        if ssl == "auto":
            ssl = "require" if host.endswith(("supabase.com", "supabase.co")) else "disable"
        if ssl == "require":
            args["ssl"] = "require"
        disable_ps = self.db_disable_prepared_statements
        if disable_ps == "auto":
            disable_ps = "true" if urlsplit(self.database_url).port == 6543 else "false"
        if disable_ps == "true":
            from uuid import uuid4

            args["statement_cache_size"] = 0
            args["prepared_statement_name_func"] = lambda: f"__asyncpg_{uuid4()}__"
        return args

    @property
    def llm_budget_micros_default(self) -> int:
        return int(self.global_monthly_llm_budget_usd * 1_000_000)

    @property
    def llm_models(self) -> list[tuple[str, str]]:
        """[(model, reasoning_effort)] in escalation order."""
        models = [(self.llm_primary_model, self.llm_primary_reasoning_effort)]
        if self.llm_fallback_model and self.llm_fallback_model != self.llm_primary_model:
            models.append((self.llm_fallback_model, self.llm_fallback_reasoning_effort))
        return models

    @property
    def jwks_url(self) -> str:
        return f"{self.supabase_url}/auth/v1/.well-known/jwks.json" if self.supabase_url else ""

    @property
    def jwt_issuer(self) -> str | None:
        return f"{self.supabase_url}/auth/v1" if self.supabase_url else None

    @property
    def scan_max_request_bytes(self) -> int:
        return self.scan_max_files * self.scan_max_file_bytes + 256 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
