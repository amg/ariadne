# Builds every image a raise runs and pushes it to core's repositories
# under one immutable tag. The backend and web images are the repository's
# own Dockerfiles with a thin aws-prod layer on top.

new_image_tag() {
  echo "$(date -u +%Y%m%d%H%M%S)-$(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

registry() { echo "$(account_id).dkr.ecr.$REGION.amazonaws.com"; }

build_and_push_images() { # <tag>
  local tag="$1"
  open_image_build "$tag"
  build_layered backend "$REPO_DIR/Dockerfile.backend" "$tag"
  build_layered web "$REPO_DIR/Dockerfile.frontend" "$tag"
  build_and_push tools "$INFRA_DIR/images/tools.Dockerfile" "$INFRA_DIR/images" "$tag"
  build_load_image "$tag"
  mirror_auth_core
}

# Builds and pushes the load generators' image alone, under its own tag, and
# records it as the one the next run's generators use.
build_and_push_load_image() { # <tag>
  open_image_build "$1"
  build_load_image "$1"
}

# The load image under the tag, and that tag as the one the generators run.
build_load_image() { # <tag>
  build_and_push load "$REPO_DIR/load/Dockerfile" "$REPO_DIR" "$1"
  put_parameter "$PARAM_LOAD_IMAGE_TAG" String "$1"
}

# The tag the generators run: the raise's own until a load image replaces it.
load_image_tag() { # <the raise's image tag>
  parameter_or "$PARAM_LOAD_IMAGE_TAG" "$1"
}

# Opens the build log and signs in to the registry, before any image is built.
open_image_build() { # <tag>
  IMAGES_LOG="$INFRA_DIR/.runs/images-$1.log"
  mkdir -p "$(dirname "$IMAGES_LOG")"
  step "Images: $1"
  info "build log: tail -f $IMAGES_LOG"
  aws ecr get-login-password |
    logged docker login --username AWS --password-stdin "$(registry)"
}

# Runs a command with its output in the build log; on failure shows the
# log's tail, so a broken build says why without scrolling a whole log.
logged() { # <command...>
  printf '\n$ %s\n' "$*" >>"$IMAGES_LOG"
  "$@" >>"$IMAGES_LOG" 2>&1 && return 0
  tail -n 40 "$IMAGES_LOG" >&2
  fail "Failed: $1 $2 (full log: $IMAGES_LOG)"
}

# The app's own image first, then the aws-prod layer on top of it.
build_layered() { # <image> <app Dockerfile> <tag>
  local base="${PROJECT}-base/$1:$3"
  info "$1 ($(date +%H:%M))"
  logged docker build --progress=plain --platform linux/amd64 -f "$2" -t "$base" "$REPO_DIR"
  logged docker build --progress=plain --platform linux/amd64 --build-arg "BASE=$base" \
    -f "$INFRA_DIR/images/$1.aws.Dockerfile" -t "$(registry)/${PROJECT}/$1:$3" "$INFRA_DIR/images"
  logged docker push "$(registry)/${PROJECT}/$1:$3"
}

build_and_push() { # <image> <Dockerfile> <context> <tag>
  info "$1 ($(date +%H:%M))"
  logged docker build --progress=plain --platform linux/amd64 -f "$2" -t "$(registry)/${PROJECT}/$1:$4" "$3"
  logged docker push "$(registry)/${PROJECT}/$1:$4"
}

# Nothing inside the app network reaches Docker Hub, so the auth core is mirrored once per release.
mirror_auth_core() {
  local target
  target="$(registry)/${PROJECT}/auth:$AUTH_CORE_TAG"
  if aws ecr describe-images --repository-name "${PROJECT}/auth" \
    --image-ids "imageTag=$AUTH_CORE_TAG" >/dev/null 2>&1; then
    info "auth core $AUTH_CORE_TAG already mirrored"
    return 0
  fi
  info "auth core $AUTH_CORE_TAG (mirroring)"
  logged docker pull --platform linux/amd64 "$AUTH_CORE_IMAGE"
  logged docker tag "$AUTH_CORE_IMAGE" "$target"
  logged docker push "$target"
}
