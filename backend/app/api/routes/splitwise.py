# backend/app/api/routes/splitwise.py
"""
Splitwise export endpoints.

Note: This implementation keeps OAuth state + tokens in-memory (dev-friendly).
"""
from __future__ import annotations

import secrets
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.api.dependencies import get_logger_dependency
from app.core.config import settings

try:
    from splitwise import Splitwise
    from splitwise.expense import Expense
    from splitwise.user import ExpenseUser
except Exception as e:  # pragma: no cover
    Splitwise = None  # type: ignore
    Expense = None  # type: ignore
    ExpenseUser = None  # type: ignore
    _IMPORT_ERROR = e


router = APIRouter(prefix="/splitwise", tags=["splitwise"])

OAUTH_STATE_TTL_SECONDS = 10 * 60
SESSION_TTL_SECONDS = 6 * 60 * 60

_oauth_state_store: Dict[str, Dict[str, Any]] = {}
_session_store: Dict[str, Dict[str, Any]] = {}


def _now() -> float:
    return time.time()


def _purge_expired() -> None:
    now = _now()
    for state, entry in list(_oauth_state_store.items()):
        if entry["expires_at"] <= now:
            _oauth_state_store.pop(state, None)
    for session_id, entry in list(_session_store.items()):
        if entry["expires_at"] <= now:
            _session_store.pop(session_id, None)


def _require_splitwise_sdk() -> None:
    if Splitwise is None:
        raise HTTPException(
            status_code=500,
            detail=f"Splitwise SDK import failed. Error: {_IMPORT_ERROR}",
        )


def _get_session(session_id: str) -> Dict[str, Any]:
    _purge_expired()
    session = _session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="Splitwise session expired. Reconnect.")
    return session


def _build_client_from_session(session: Dict[str, Any]) -> "Splitwise":
    _require_splitwise_sdk()
    kwargs: Dict[str, Any] = {"api_key": session.get("api_key")}
    if session.get("oauth2_token"):
        kwargs["oauth2_access_token"] = session["oauth2_token"]
    client = Splitwise(session["consumer_key"], session["consumer_secret"], **kwargs)
    return client


def _best_frontend_origin(request: Request, explicit: Optional[str]) -> str:
    if explicit:
        return explicit
    origin = request.headers.get("origin")
    if origin:
        return origin
    return settings.allowed_origins[0] if settings.allowed_origins else "*"


class OAuth2StartRequest(BaseModel):
    consumer_key: str = Field(..., min_length=3)
    consumer_secret: str = Field(..., min_length=3)
    api_key: Optional[str] = None
    frontend_origin: Optional[str] = None


class OAuth2StartResponse(BaseModel):
    authorization_url: str
    state: str
    redirect_uri: str


class ApiKeyConnectRequest(BaseModel):
    api_key: str = Field(..., min_length=10, description="Splitwise personal access token / API key")


class ApiKeyConnectResponse(BaseModel):
    session_id: str
    me: SplitwiseUserOut


@router.post("/connect", response_model=ApiKeyConnectResponse)
async def splitwise_connect_with_api_key(
    request: ApiKeyConnectRequest,
):
    """
    Connect using a Splitwise API key (Bearer token). This avoids popup OAuth and matches:
      Splitwise(consumer_key, consumer_secret, api_key=...)
      getCurrentUser()
    """
    _require_splitwise_sdk()
    _purge_expired()

    consumer_key = "api_key_only"
    consumer_secret = "api_key_only"

    session_id = secrets.token_urlsafe(24)
    session = {
        "consumer_key": consumer_key,
        "consumer_secret": consumer_secret,
        "api_key": request.api_key.strip(),
        "oauth2_token": None,
        "expires_at": _now() + SESSION_TTL_SECONDS,
    }

    # Validate credentials immediately.
    client = _build_client_from_session(session)
    try:
        me = client.getCurrentUser()
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Splitwise authentication failed: {e}")

    _session_store[session_id] = session

    me_out = {
        "id": int(me.getId()),
        "first_name": me.getFirstName(),
        "last_name": me.getLastName(),
        "email": me.getEmail(),
        "display_name": " ".join([p for p in [me.getFirstName(), me.getLastName()] if p]).strip() or (me.getEmail() or "Me"),
    }
    return {"session_id": session_id, "me": me_out}


@router.post("/oauth2/start", response_model=OAuth2StartResponse)
async def splitwise_oauth2_start(
    request: OAuth2StartRequest,
    http_request: Request,
    logger=Depends(get_logger_dependency),
):
    """
    Start OAuth2 by returning an authorization URL.
    Frontend should open it in a popup window.
    """
    _require_splitwise_sdk()
    _purge_expired()

    redirect_uri = str(http_request.base_url).rstrip("/") + "/api/splitwise/oauth2/callback"

    client = Splitwise(
        request.consumer_key,
        request.consumer_secret,
        api_key=request.api_key,
    )

    authorization_url, state = client.getOAuth2AuthorizeURL(redirect_uri=redirect_uri)
    _oauth_state_store[state] = {
        "consumer_key": request.consumer_key,
        "consumer_secret": request.consumer_secret,
        "api_key": request.api_key,
        "redirect_uri": redirect_uri,
        "frontend_origin": _best_frontend_origin(http_request, request.frontend_origin),
        "expires_at": _now() + OAUTH_STATE_TTL_SECONDS,
    }

    logger.info("Splitwise OAuth2 start created")
    return OAuth2StartResponse(
        authorization_url=authorization_url,
        state=state,
        redirect_uri=redirect_uri,
    )


@router.get("/oauth2/callback", response_class=HTMLResponse)
async def splitwise_oauth2_callback(
    http_request: Request,
    code: str = Query(..., description="OAuth2 authorization code"),
    state: str = Query(..., description="OAuth2 state"),
    logger=Depends(get_logger_dependency),
):
    """
    OAuth2 redirect target. Exchanges code for token, then posts a message to the opener window.
    """
    _require_splitwise_sdk()
    _purge_expired()

    state_entry = _oauth_state_store.pop(state, None)
    if not state_entry:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state. Please restart connect.")

    client = Splitwise(
        state_entry["consumer_key"],
        state_entry["consumer_secret"],
        api_key=state_entry.get("api_key"),
    )

    oauth2_token = client.getOAuth2AccessToken(code=code, redirect_uri=state_entry["redirect_uri"])
    if not oauth2_token:
        raise HTTPException(status_code=401, detail="Splitwise OAuth2 token exchange failed.")

    session_id = secrets.token_urlsafe(24)
    _session_store[session_id] = {
        "consumer_key": state_entry["consumer_key"],
        "consumer_secret": state_entry["consumer_secret"],
        "api_key": state_entry.get("api_key"),
        "oauth2_token": oauth2_token,
        "expires_at": _now() + SESSION_TTL_SECONDS,
    }

    frontend_origin = state_entry.get("frontend_origin") or _best_frontend_origin(http_request, None)
    logger.info("Splitwise OAuth2 callback success")

    html = f"""<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Splitwise Connected</title></head>
  <body style="font-family: ui-sans-serif, system-ui; padding: 24px; background: #f9fafb;">
    <div style="max-width: 720px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">Splitwise connected</h2>
      <p style="margin: 0 0 16px; color: #4b5563;">
        This window should close automatically. If it doesn’t, copy the session id below and paste it into the app.
      </p>

      <div style="margin: 12px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #f9fafb;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 6px;">Session ID</div>
        <code id="sid" style="font-size: 13px; color: #111827; word-break: break-all;">{session_id}</code>
      </div>

      <div style="display: flex; gap: 10px; align-items: center;">
        <button id="copy" style="border: 1px solid #d1d5db; background: #fff; border-radius: 10px; padding: 10px 12px; cursor: pointer;">
          Copy session id
        </button>
        <span id="copied" style="font-size: 12px; color: #16a34a; display: none;">Copied</span>
      </div>
    </div>
    <script>
      (function () {{
        try {{
          var payload = {{ type: "splitwise_oauth2", ok: true, sessionId: "{session_id}", state: "{state}" }};
          if (window.opener && window.opener.postMessage) {{
            try {{ window.opener.postMessage(payload, "{frontend_origin}"); }} catch (e) {{}}
            try {{ window.opener.postMessage(payload, "*"); }} catch (e) {{}}
          }}
        }} catch (e) {{}}
      }})();

      document.getElementById("copy").addEventListener("click", async function () {{
        try {{
          await navigator.clipboard.writeText("{session_id}");
          document.getElementById("copied").style.display = "inline";
          setTimeout(function () {{ document.getElementById("copied").style.display = "none"; }}, 1200);
        }} catch (e) {{
          // best-effort
        }}
      }});

      setTimeout(function () {{ try {{ window.close(); }} catch (e) {{}} }}, 300);
    </script>
  </body>
</html>"""
    return HTMLResponse(content=html)


class SplitwiseUserOut(BaseModel):
    id: int
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    display_name: str


class SplitwiseGroupOut(BaseModel):
    id: int
    name: str
    members: List[SplitwiseUserOut]


@router.get("/me")
async def splitwise_me(
    session_id: str = Query(...),
):
    _require_splitwise_sdk()
    session = _get_session(session_id)
    client = _build_client_from_session(session)
    me = client.getCurrentUser()
    return {
        "id": me.getId(),
        "first_name": me.getFirstName(),
        "last_name": me.getLastName(),
        "email": me.getEmail(),
        "display_name": " ".join([p for p in [me.getFirstName(), me.getLastName()] if p]).strip() or (me.getEmail() or "Me"),
    }


def _serialize_member(member: Any) -> Dict[str, Any]:
    member_id = member.getId()
    first_name = member.getFirstName()
    last_name = member.getLastName()
    email = member.getEmail()
    display_name = " ".join([p for p in [first_name, last_name] if p]).strip() or (email or f"User {member_id}")
    return {
        "id": int(member_id),
        "first_name": first_name,
        "last_name": last_name,
        "email": email,
        "display_name": display_name,
    }


def _serialize_group(group: Any) -> Dict[str, Any]:
    members = group.getMembers() or []
    return {
        "id": int(group.getId()),
        "name": group.getName(),
        "members": [_serialize_member(m) for m in members],
    }


@router.get("/groups", response_model=List[SplitwiseGroupOut])
async def splitwise_groups(
    session_id: str = Query(...),
):
    _require_splitwise_sdk()
    session = _get_session(session_id)
    client = _build_client_from_session(session)
    groups = client.getGroups()
    return [_serialize_group(g) for g in groups]


@router.get("/groups/{group_id}", response_model=SplitwiseGroupOut)
async def splitwise_group(
    group_id: int,
    session_id: str = Query(...),
):
    _require_splitwise_sdk()
    session = _get_session(session_id)
    client = _build_client_from_session(session)
    group = client.getGroup(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return _serialize_group(group)


class ExpenseShareIn(BaseModel):
    user_id: int
    owed_share: str
    paid_share: str


class CreateExpenseRequest(BaseModel):
    session_id: str
    group_id: int
    description: str = Field(..., min_length=1, max_length=200)
    cost: str = Field(..., description="Total cost as a decimal string")
    currency_code: Optional[str] = None
    date: Optional[str] = None
    shares: List[ExpenseShareIn] = Field(..., min_length=1)


@router.post("/expense/create")
async def splitwise_create_expense(
    request: CreateExpenseRequest,
):
    _require_splitwise_sdk()
    session = _get_session(request.session_id)
    client = _build_client_from_session(session)

    expense = Expense()
    expense.setGroupId(str(request.group_id))
    expense.setDescription(request.description)
    expense.setCost(request.cost)
    if request.currency_code:
        expense.setCurrencyCode(request.currency_code)
    if request.date:
        expense.setDate(request.date)

    for share in request.shares:
        u = ExpenseUser()
        u.setId(int(share.user_id))
        u.setOwedShare(str(share.owed_share))
        u.setPaidShare(str(share.paid_share))
        expense.addUser(u)

    created, errors = client.createExpense(expense)
    if errors is not None:
        raise HTTPException(status_code=400, detail=getattr(errors, "errors", None) or "Splitwise returned errors")
    if created is None:
        raise HTTPException(status_code=500, detail="Splitwise did not return created expense")

    return {"expense_id": created.getId()}
