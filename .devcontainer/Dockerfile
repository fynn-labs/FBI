FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# System deps: Chromium (Playwright), Erlang build toolchain, SQLite CLI,
# inotify-tools (Phoenix's file_system dep for live code reload).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      build-essential autoconf m4 libncurses-dev libssl-dev libssh-dev \
      sqlite3 \
      inotify-tools \
 && rm -rf /var/lib/apt/lists/*

# Pinned versions — bump these in one place when upgrading.
ARG ASDF_VERSION=v0.14.1
ARG ERLANG_VERSION=27.2
ARG ELIXIR_VERSION=1.18.1-otp-27

# asdf + Erlang + Elixir installed under /opt so any runtime user can use them.
# Both ASDF_DIR (asdf code) and ASDF_DATA_DIR (plugins/installs/shims) point at
# the same root so shim resolution is independent of $HOME. Hex/rebar/phx_new
# live under /opt/mix-home via MIX_HOME so users get them without per-user
# setup. MIX_HOME is read-only for non-root; users who need to install their
# own archives can override MIX_HOME locally.
#
# kerl flags skip wx/observer/jinterface (X11/GUI parts unusable headlessly)
# and skip docs — both shorten the Erlang compile and shrink the image.
ENV ASDF_DIR=/opt/asdf
ENV ASDF_DATA_DIR=/opt/asdf
ENV MIX_HOME=/opt/mix-home
ENV PATH="/opt/asdf/shims:/opt/asdf/bin:${PATH}"
ENV KERL_BUILD_DOCS=no
ENV KERL_INSTALL_MANPAGES=no
ENV KERL_INSTALL_HTMLDOCS=no
ENV KERL_CONFIGURE_OPTIONS="--disable-debug --without-javac --without-wx --without-observer --without-debugger --without-et --without-jinterface"

# asdf itself + plugin registration. Runs as root; /opt is world-readable.
RUN git clone --depth 1 --branch ${ASDF_VERSION} https://github.com/asdf-vm/asdf.git $ASDF_DIR \
 && $ASDF_DIR/bin/asdf plugin add erlang \
 && $ASDF_DIR/bin/asdf plugin add elixir

# Erlang/OTP — the slow step (~5-10 min first build, compiled from source).
# Isolated in its own layer so tweaks to later steps don't force a recompile.
RUN $ASDF_DIR/bin/asdf install erlang ${ERLANG_VERSION} \
 && $ASDF_DIR/bin/asdf global  erlang ${ERLANG_VERSION} \
 && rm -rf $ASDF_DIR/plugins/erlang/kerl-home/builds /root/.cache

# Elixir — fast (precompiled bytecode, ~30s).
RUN $ASDF_DIR/bin/asdf install elixir ${ELIXIR_VERSION} \
 && $ASDF_DIR/bin/asdf global  elixir ${ELIXIR_VERSION}

# Hex, rebar, and the Phoenix project generator — shared via MIX_HOME.
RUN mkdir -p $MIX_HOME \
 && $ASDF_DIR/shims/mix local.hex    --force \
 && $ASDF_DIR/shims/mix local.rebar  --force \
 && $ASDF_DIR/shims/mix archive.install hex phx_new --force

# World-readable perms on shared dirs. Purge root-owned /tmp cruft (Mix's
# pubsub coordinator Mix.Sync.PubSub creates per-build dirs there and the
# root-owned leftovers from `mix archive.install` would block other users).
# Pre-create /tmp/mix_pubsub with sticky+world-writable so different users
# can run Mix in the same container without collisions.
RUN chmod -R a+rX /opt/asdf /opt/mix-home \
 && rm -rf /tmp/* /var/tmp/* /root/.cache \
 && mkdir -p /tmp/mix_pubsub \
 && chmod 1777 /tmp/mix_pubsub

# Default version resolution. `asdf global` writes to $HOME/.tool-versions,
# which is user-specific; these env vars give asdf a default independent of
# $HOME so commands resolve for any runtime user. Project-local .tool-versions
# would normally override, but the env var takes precedence — acceptable here
# since this devcontainer is pinned to one Elixir version. Unset locally if
# you need a project-specific version.
ENV ASDF_ERLANG_VERSION=${ERLANG_VERSION}
ENV ASDF_ELIXIR_VERSION=${ELIXIR_VERSION}

# UTF-8 locale — base image ships latin1, which Elixir warns about (it expects
# utf8 for correct string handling).
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
