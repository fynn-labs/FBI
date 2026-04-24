FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Chromium for Playwright; build deps for Erlang/OTP; sqlite CLI for DB debugging;
# inotify-tools for Phoenix's file_system dep (live code reload).
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

# asdf + Erlang + Elixir under the devcontainer's default non-root user.
# kerl flags skip wx/observer/jinterface (X11/GUI parts unusable headlessly)
# which also shortens the Erlang compile and keeps the image smaller.
USER node
ENV ASDF_DIR=/home/node/.asdf
ENV PATH="/home/node/.asdf/shims:/home/node/.asdf/bin:${PATH}"
ENV KERL_BUILD_DOCS=no
ENV KERL_INSTALL_MANPAGES=no
ENV KERL_INSTALL_HTMLDOCS=no
ENV KERL_CONFIGURE_OPTIONS="--disable-debug --without-javac --without-wx --without-observer --without-debugger --without-et --without-jinterface"

# asdf itself + plugin registration + shell integration for interactive + login shells.
# Using direct paths avoids any login-profile PATH-override headaches.
RUN git clone --depth 1 --branch ${ASDF_VERSION} https://github.com/asdf-vm/asdf.git $ASDF_DIR \
 && echo '. $HOME/.asdf/asdf.sh' >> /home/node/.bashrc \
 && echo '. $HOME/.asdf/asdf.sh' >> /home/node/.profile \
 && $ASDF_DIR/bin/asdf plugin add erlang \
 && $ASDF_DIR/bin/asdf plugin add elixir

# Erlang/OTP — the slow step (~5-10 min on first build, compiled from source).
# Kept in its own layer so tweaks to later steps don't force a recompile.
RUN $ASDF_DIR/bin/asdf install erlang ${ERLANG_VERSION} \
 && $ASDF_DIR/bin/asdf global  erlang ${ERLANG_VERSION} \
 && rm -rf $ASDF_DIR/plugins/erlang/kerl-home/builds /home/node/.cache

# Elixir — fast (precompiled bytecode, ~30s).
RUN $ASDF_DIR/bin/asdf install elixir ${ELIXIR_VERSION} \
 && $ASDF_DIR/bin/asdf global  elixir ${ELIXIR_VERSION}

# Hex, rebar, and the Phoenix project generator.
RUN $ASDF_DIR/shims/mix local.hex   --force \
 && $ASDF_DIR/shims/mix local.rebar --force \
 && $ASDF_DIR/shims/mix archive.install hex phx_new --force

USER root

# UTF-8 locale — the base image ships with latin1, which Elixir warns about
# (it expects utf8 for correct string handling).
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
