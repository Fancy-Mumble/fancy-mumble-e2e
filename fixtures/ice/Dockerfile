FROM debian:bookworm-slim

# Debian's prebuilt Ice packages, against the system python3. Building the
# Python mapping from source (`pip install zeroc-ice`) compiles Ice itself and
# takes minutes; nothing here needs a version newer than the one the server is
# linked against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-zeroc-ice \
      zeroc-ice-all-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ice

# The server submodule's own slice, taken at build time rather than vendored
# beside this file. A second copy is a copy that drifts, and Ice marshals
# structs positionally with no versioning - so drift surfaces as a truncated
# read of a struct rather than as a version error, which is the exact hazard
# vendor/channelviewer/sync-slice.sh exists to warn about.
#
# Build with the submodule as a named context:
#
#   docker build -t fancy-e2e-ice:latest \
#     --build-context slice=vendor/server/src/murmur fixtures/ice
COPY --from=slice MumbleServer.ice .

# `-I` is required: MumbleServer.ice includes <Ice/SliceChecksumDict.ice>, and
# slice2py does not search Ice's own share directory by default.
RUN slice2py -I/usr/share/ice/slice MumbleServer.ice
