from functools import lru_cache
from typing import Any, List, Optional
from urllib.parse import urlparse
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing_extensions import Self

DEFAULT_DEV_CORS_ORIGINS: List[str] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5175",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

PRODUCTION_ALLOWED_METHODS: List[str] = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
]

PRODUCTION_ALLOWED_HEADERS: List[str] = [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With",
]


class Settings(BaseSettings):
    """Application settings and runtime configuration."""

    PROJECT_NAME: str = Field(default="BrandShield AI Backend", description="Application name")
    VERSION: str = Field(default="0.1.0", description="Application version")
    DESCRIPTION: str = Field(
        default="Intelligent brand-governance platform API — CodeNova India 2026 Round 2",
        description="Application description",
    )
    API_V1_STR: str = Field(default="/api/v1", description="Prefix for Version 1 API routes")
    ENVIRONMENT: str = Field(
        default="development",
        description="Runtime environment ('development' | 'staging' | 'production')",
    )
    DEBUG: bool = Field(default=False, description="Debug mode toggle")

    # Allowed CORS Origins
    BACKEND_CORS_ORIGINS: List[str] = Field(
        default_factory=lambda: list(DEFAULT_DEV_CORS_ORIGINS),
        description="Allowed CORS origins for frontend clients",
    )

    # Database Configuration (PostgreSQL + asyncpg)
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/brandshield_ai",
        description="Asynchronous database connection URL",
    )
    DATABASE_POOL_SIZE: int = Field(default=10, description="Database connection pool size")
    DATABASE_MAX_OVERFLOW: int = Field(default=20, description="Database connection pool max overflow")
    DATABASE_POOL_PRE_PING: bool = Field(default=True, description="Enable connection pre-ping to prune stale sockets")
    DATABASE_POOL_RECYCLE: int = Field(default=1800, description="Recycle connections after N seconds (default 30m)")

    # Authentication & Security
    JWT_SECRET_KEY: str = Field(
        default="dev_secret_jwt_key_do_not_use_in_production_brandshield_ai_2026",
        description="Cryptographic secret key for signing JWT tokens",
    )
    JWT_ALGORITHM: str = Field(default="HS256", description="JWT algorithm")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=1440,
        description="Access token lifespan in minutes (default 24 hours)",
    )

    # Optional Development-Only Admin Provisioning (Strictly disabled in production)
    DEV_ADMIN_EMAIL: Optional[str] = Field(
        default=None,
        description="Optional development-only admin email configured via environment variables",
    )
    DEV_ADMIN_PASSWORD: Optional[str] = Field(
        default=None,
        description="Optional development-only admin password configured via environment variables",
    )

    # Database Initialization & Seeding
    BOOTSTRAP_ON_STARTUP: bool = Field(
        default=True,
        description="Whether to execute database schema creation and seed checks during application startup",
    )

    # Production Bootstrap Credentials (Optional; if unset in production, demo seeding is disabled)
    BOOTSTRAP_REVIEWER_PASSWORD: Optional[str] = Field(
        default=None,
        description="Optional secure password to bootstrap initial reviewer in production",
    )
    BOOTSTRAP_CREATOR_PASSWORD: Optional[str] = Field(
        default=None,
        description="Optional secure password to bootstrap initial creator in production",
    )

    # AI & Agentic Provider Configuration
    GEMINI_API_KEY: Optional[str] = Field(
        default=None,
        description="Google Gemini API key for semantic compliance evaluation",
    )
    OPENAI_API_KEY: Optional[str] = Field(
        default=None,
        description="OpenAI API key fallback for semantic compliance evaluation",
    )
    AI_MODEL_NAME: str = Field(
        default="gemini-1.5-pro",
        description="Model identifier for LLM compliance reasoning",
    )

    @property
    def is_ai_available(self) -> bool:
        """Indicate whether an external LLM provider API key is configured."""
        return bool(self.GEMINI_API_KEY or self.OPENAI_API_KEY)

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: Any) -> Any:
        """Parse comma-separated origins string or validate list."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    @model_validator(mode="after")
    def validate_environment_and_cors(self) -> Self:
        """Enforce strict CORS separation between development and production."""
        env = self.ENVIRONMENT.lower()
        if env == "production":
            if not self.BACKEND_CORS_ORIGINS or self.BACKEND_CORS_ORIGINS == DEFAULT_DEV_CORS_ORIGINS:
                raise ValueError(
                    "BACKEND_CORS_ORIGINS must be explicitly configured with trusted production domains."
                )
            for origin in self.BACKEND_CORS_ORIGINS:
                parsed = urlparse(origin)
                hostname = (parsed.hostname or "").lower()
                if not hostname or hostname in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
                    raise ValueError(
                        f"Insecure origin '{origin}' is not permitted in production environment. "
                        "Only valid, trusted remote domains are allowed."
                    )
                if parsed.scheme != "https":
                    raise ValueError(
                        f"Insecure scheme in '{origin}'. Production origins must use HTTPS."
                    )
            if (
                not self.JWT_SECRET_KEY
                or self.JWT_SECRET_KEY == "dev_secret_jwt_key_do_not_use_in_production_brandshield_ai_2026"
                or len(self.JWT_SECRET_KEY.strip()) < 32
            ):
                raise ValueError(
                    "JWT_SECRET_KEY must be overridden with a secure production secret (minimum 32 characters) in production environment."
                )

            if not self.DATABASE_URL or self.DATABASE_URL.startswith("sqlite"):
                raise ValueError(
                    "SQLite DATABASE_URL is not permitted in production environment. Configure PostgreSQL."
                )
            if (
                "postgres:postgres@localhost" in self.DATABASE_URL
                or "user:pass@" in self.DATABASE_URL
                or "YOUR_SECURE_PASSWORD" in self.DATABASE_URL
            ):
                raise ValueError(
                    "Insecure default or placeholder database credentials are not permitted in production environment. Configure secure DATABASE_URL."
                )
        return self

    @property
    def cors_allow_methods(self) -> List[str]:
        """Return allowed HTTP methods based on runtime environment."""
        if self.ENVIRONMENT.lower() == "production":
            return list(PRODUCTION_ALLOWED_METHODS)
        return ["*"]

    @property
    def cors_allow_headers(self) -> List[str]:
        """Return allowed request headers based on runtime environment."""
        if self.ENVIRONMENT.lower() == "production":
            return list(PRODUCTION_ALLOWED_HEADERS)
        return ["*"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Return cached application settings singleton."""
    return Settings()


settings = get_settings()
