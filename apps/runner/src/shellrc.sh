# KojyAI shell start-up (bash --rcfile). Runs as the bot's own sandbox user,
# in the bot's folder. See apps/runner/src/terminal.ts.

PS1='\[\e[38;5;79m\]${KOJY_BOT_NAME:-bot}\[\e[0m\]:\[\e[38;5;75m\]\w\[\e[0m\]\$ '
HISTSIZE=2000
HISTCONTROL=ignoreboth
shopt -s histappend checkwinsize 2>/dev/null

alias ls='ls --color=auto'
alias ll='ls -la --color=auto'
alias grep='grep --color=auto'

if [ -z "$KOJY_SHELL_QUIET" ]; then
  printf '\e[2mKojyAI shell for %s. Your bot'"'"'s secrets are set as environment variables.\n' "${KOJY_BOT_NAME:-this bot}"
  printf 'Python: %s  ·  git, pip and your bot'"'"'s files are here. Type exit to close.\e[0m\n' "$(python --version 2>&1 | cut -d' ' -f2)"
fi
