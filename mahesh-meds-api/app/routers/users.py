"""Staff users."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import Center, User, Role
from app.schemas import UserCreate, UserOut, UserUpdate
from app.security import validate_csrf
from app.permissions import (
    enforce_user_self_management_rules,
    invalidate_permission_cache,
    require_permission,
)
from app.audit import write_audit_log

router = APIRouter()


# --- User APIs ---
@router.get("/api/v1/users", response_model=list[UserOut])
def list_users(
    request: Request,
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
):
    """Returns users; used by admin user management and role checks.
    By default, only active users are returned."""
    query = db.query(User).options(joinedload(User.roles))
    if not include_inactive:
        query = query.filter(User.is_active == True)
    rows = query.order_by(User.created_at.desc()).all()
    write_audit_log(db, request, action="users_list_viewed", entity_type="admin", current_user=current_user)
    db.commit()
    # Transform roles for output
    result = []
    for user in rows:
        # Convert Role objects to string names BEFORE Pydantic validation
        role_names = [role.name for role in user.roles]
        # Create a dict with roles as strings for proper validation
        user_data = {
            "id": user.id,
            "name": user.name,
            "mobile": user.mobile,
            "is_active": user.is_active,
            "center_id": user.center_id,
            "last_login": user.last_login,
            "created_at": user.created_at,
            "roles": role_names
        }
        user_dict = UserOut.model_validate(user_data).model_dump()
        result.append(user_dict)
    return result


@router.post("/api/v1/users", response_model=UserOut)
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Creates a user after role and center validation. Assigns roles from payload."""
    if payload.center_id and not db.get(Center, payload.center_id):
        raise HTTPException(status_code=400, detail="Invalid center_id")

    # Extract roles from payload
    role_names = payload.roles or []
    user_data = payload.model_dump(exclude={"roles"})

    # Create user
    user = User(**user_data)
    db.add(user)
    db.flush()  # Get user.id without committing

    # Assign roles if provided
    if role_names:
        roles = db.query(Role).filter(Role.name.in_(role_names)).all()
        found_role_names = {r.name for r in roles}
        invalid_roles = set(role_names) - found_role_names
        if invalid_roles:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Invalid roles: {', '.join(invalid_roles)}")
        user.roles = roles

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Mobile already exists") from None

    db.refresh(user)
    write_audit_log(
        db,
        request,
        action="user_created",
        entity_type="admin",
        entity_id=user.id,
        center_id=user.center_id,
        new_value={"roles": role_names, "mobile": user.mobile, "name": user.name},
        current_user=current_user,
    )
    db.commit()

    # Return with roles - convert to strings BEFORE validation
    role_names_out = [role.name for role in user.roles]
    user_data = {
        "id": user.id,
        "name": user.name,
        "mobile": user.mobile,
        "is_active": user.is_active,
        "center_id": user.center_id,
        "last_login": user.last_login,
        "created_at": user.created_at,
        "roles": role_names_out
    }
    result = UserOut.model_validate(user_data).model_dump()
    return result


@router.patch("/api/v1/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    payload: UserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Partially updates user profile/roles/status."""
    user = db.query(User).options(joinedload(User.roles)).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    before = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    data = payload.model_dump(exclude_unset=True)

    # Handle roles update separately
    new_roles = None
    if "roles" in data:
        role_names = data.pop("roles")
        if role_names is not None:
            roles = db.query(Role).filter(Role.name.in_(role_names)).all()
            found_role_names = {r.name for r in roles}
            invalid_roles = set(role_names) - found_role_names
            if invalid_roles:
                raise HTTPException(status_code=400, detail=f"Invalid roles: {', '.join(invalid_roles)}")
            new_roles = roles

    if "center_id" in data and data["center_id"] is not None and data["center_id"] and not db.get(Center, data["center_id"]):
        raise HTTPException(status_code=400, detail="Invalid center_id")

    enforce_user_self_management_rules(
        current_user,
        user.id,
        is_active=data.get("is_active"),
        role_names=[role.name for role in new_roles] if new_roles is not None else None,
    )

    # Update other fields
    for key, value in data.items():
        setattr(user, key, value)

    auth_context_changed = any(key in data for key in ("center_id", "is_active"))

    # Update roles if provided
    if new_roles is not None:
        user.roles = new_roles
        auth_context_changed = True

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Mobile already exists") from None

    if auth_context_changed:
        invalidate_permission_cache(user.id)

    db.refresh(user)

    new_value = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    write_audit_log(
        db,
        request,
        action="user_updated",
        entity_type="admin",
        entity_id=user.id,
        center_id=user.center_id,
        old_value=before,
        new_value=new_value,
        current_user=current_user,
    )
    db.commit()

    # Return with roles - convert to strings BEFORE validation
    role_names_out = [role.name for role in user.roles]
    user_data = {
        "id": user.id,
        "name": user.name,
        "mobile": user.mobile,
        "is_active": user.is_active,
        "center_id": user.center_id,
        "last_login": user.last_login,
        "created_at": user.created_at,
        "roles": role_names_out
    }
    result = UserOut.model_validate(user_data).model_dump()
    return result


@router.delete("/api/v1/users/{user_id}")
def delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("users.manage")),
    _: None = Depends(validate_csrf),
):
    """Soft deletes user by setting is_active=false."""
    user = db.query(User).options(joinedload(User.roles)).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    enforce_user_self_management_rules(current_user, user.id, is_active=False)

    before = {
        "name": user.name,
        "mobile": user.mobile,
        "center_id": user.center_id,
        "is_active": user.is_active,
        "roles": [role.name for role in user.roles],
    }

    # Soft delete: set is_active to false
    user.is_active = False
    db.commit()

    write_audit_log(
        db,
        request,
        action="user_deleted",
        entity_type="admin",
        entity_id=user_id,
        center_id=before.get("center_id"),
        old_value=before,
        new_value={"is_active": False},
        current_user=current_user,
    )
    db.commit()

    # Invalidate permission cache
    invalidate_permission_cache(user_id)

    return {"status": "deleted"}
