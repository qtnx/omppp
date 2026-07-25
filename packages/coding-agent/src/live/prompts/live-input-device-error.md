omp Live needs a microphone, but no usable input device was found on this machine.

If you are running omp over SSH, the audio devices live on your local machine, not the server. Start Live on the server with `/live --remote`, then run the printed `ompx live --attach <ssh-target>` command on your laptop to use its microphone and speaker.

Otherwise, connect a microphone and run `/live` again.
