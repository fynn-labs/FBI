export interface GitAuthMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface GitAuth {
  describe(): string;                        // for logs
  mounts(): GitAuthMount[];
  env(): Record<string, string>;
}

/**
 * SSH agent forwarding. The host's ssh-agent socket is bind-mounted into the
 * container at /ssh-agent, and SSH_AUTH_SOCK is set accordingly in env().
 */
export class SshAgentForwarding implements GitAuth {
  constructor(private hostSocket: string, private bindSource: string = hostSocket) {
    if (!hostSocket) {
      throw new Error(
        'HOST_SSH_AUTH_SOCK is empty; start an ssh-agent and load keys first.'
      );
    }
  }

  describe(): string {
    return `ssh-agent-forwarding(${this.hostSocket})`;
  }

  mounts(): GitAuthMount[] {
    return [{ source: this.bindSource, target: '/ssh-agent', readOnly: false }];
  }

  env(): Record<string, string> {
    return { SSH_AUTH_SOCK: '/ssh-agent' };
  }
}
