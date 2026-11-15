from contextlib import asynccontextmanager
import logging
from typing import AsyncGenerator

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.health import get_health
from app.api.v1.router import api_router
from app.core.config import settings
from app.schemas.health import HealthResponse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("brandshield.backend")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context manager for startup and shutdown events."""
    logger.info(
        "Initializing %s v%s (%s)",
        settings.PROJECT_NAME,
        settings.VERSION,
        settings.ENVIRONMENT,
    )
    if settings.BOOTSTRAP_ON_STARTUP:
        from app.core.bootstrap import bootstrap_database
        await bootstrap_database()
    yield
    logger.info("Shutting down %s", settings.PROJECT_NAME)


def create_application(app_settings: Settings | None = None) -> FastAPI:
    """Instantiate and configure the FastAPI application."""
    current_settings = app_settings or settings
    application = FastAPI(
        title=current_settings.PROJECT_NAME,
        version=current_settings.VERSION,
        description=current_settings.DESCRIPTION,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # Configure CORS middleware with environment-specific restrictions
    application.add_middleware(
        CORSMiddleware,
        allow_origins=current_settings.BACKEND_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=current_settings.cors_allow_methods,
        allow_headers=current_settings.cors_allow_headers,
    )

    # Security headers middleware enforcing OWASP defense-in-depth headers
    @application.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        if current_settings.ENVIRONMENT.lower() == "production":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    # Structured error handlers for all HTTP and Starlette routing exceptions
    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        logger.warning("HTTP %d on %s: %s", exc.status_code, request.url.path, exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": True,
                "status_code": exc.status_code,
                "message": exc.detail,
            },
        )

    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        logger.warning("Validation error on %s: %s", request.url.path, exc.errors())
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": True,
                "status_code": status.HTTP_422_UNPROCESSABLE_ENTITY,
                "message": "Validation error in request parameters or body",
                "details": jsonable_encoder(exc.errors()),
            },
        )

    @application.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.error("Unhandled error on %s: %s", request.url.path, exc, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": True,
                "status_code": status.HTTP_500_INTERNAL_SERVER_ERROR,
                "message": "Internal server error",
            },
        )

    # Core health-check endpoint: GET /health
    application.add_api_route(
        "/health",
        get_health,
        methods=["GET"],
        response_model=HealthResponse,
        summary="Service Health Check (Root)",
        description="Returns operational status, version, environment, and UTC timestamp.",
        tags=["Health"],
    )

    # Include versioned API router (/api/v1)
    application.include_router(api_router, prefix=settings.API_V1_STR)

    # Root welcome / discovery route: GET /
    @application.get(
        "/",
        summary="Root Status",
        description="Returns general service metadata and documentation links.",
        tags=["System"],
    )
    async def root_info() -> dict:
        return {
            "service": settings.PROJECT_NAME,
            "version": settings.VERSION,
            "status": "operational",
            "documentation": "/docs",
            "health_check": "/health",
        }

    return application


app = create_application()
