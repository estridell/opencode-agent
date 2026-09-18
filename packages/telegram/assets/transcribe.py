import sys

from faster_whisper import WhisperModel


def main() -> None:
    if len(sys.argv) not in (6, 7):
        raise SystemExit("Invalid voice transcription arguments.")

    action, model_name, language, threads_text, model_directory = sys.argv[1:6]
    try:
        threads = int(threads_text)
    except ValueError as error:
        raise SystemExit("Invalid voice thread count.") from error

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
        num_workers=1,
        download_root=model_directory,
        local_files_only=action == "transcribe",
    )
    if action == "prepare" and len(sys.argv) == 6:
        return
    if action != "transcribe" or len(sys.argv) != 7:
        raise SystemExit("Invalid voice transcription action.")

    segments, _ = model.transcribe(
        sys.argv[6],
        language=language,
        beam_size=1,
        best_of=1,
        vad_filter=True,
    )
    print("".join(segment.text for segment in segments).strip())


if __name__ == "__main__":
    main()
