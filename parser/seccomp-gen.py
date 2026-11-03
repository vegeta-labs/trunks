#!/usr/bin/env python3
"""Builds the seccomp filter that bubblewrap applies to every parser task (tech design T7, self-test WR-F3).

Runs at image build time (python3-seccomp, Debian). Default: allow. Denied with EPERM: everything a compromised task
would need to leave or attack the sandbox's kernel surface: new namespaces, mounts, keyrings, BPF, io_uring, ptrace,
userfaultfd, perf events. clone3 gets ENOSYS so libc falls back to clone, whose namespace flags are checked.
"""
import errno
import sys

import seccomp

CLONE_NS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000 | 0x00000080
# NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET | NEWTIME

f = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
for name in ['unshare', 'setns', 'mount', 'umount2', 'pivot_root', 'chroot', 'keyctl', 'add_key', 'request_key', 'bpf',
             'io_uring_setup', 'io_uring_enter', 'io_uring_register', 'ptrace', 'process_vm_readv', 'process_vm_writev',
             'userfaultfd', 'perf_event_open', 'open_by_handle_at', 'fsopen', 'fsmount', 'fspick', 'move_mount',
             'open_tree', 'mount_setattr', 'kexec_load', 'init_module', 'finit_module', 'delete_module']:
    try:
        f.add_rule(seccomp.ERRNO(errno.EPERM), name)
    except Exception:
        pass  # not on this architecture
f.add_rule(seccomp.ERRNO(errno.ENOSYS), 'clone3')
f.add_rule(seccomp.ERRNO(errno.EPERM), 'clone', seccomp.Arg(0, seccomp.MASKED_EQ, CLONE_NS, CLONE_NS))
for flag in [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000, 0x00000080]:
    f.add_rule(seccomp.ERRNO(errno.EPERM), 'clone', seccomp.Arg(0, seccomp.MASKED_EQ, flag, flag))

with open(sys.argv[1], 'wb') as out:
    f.export_bpf(out)
