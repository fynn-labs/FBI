defmodule FBI.Orchestrator.Tar do
  @moduledoc "Build a minimal ustar tar archive from a map of filename => binary."

  @spec build(%{String.t() => binary()}) :: binary()
  def build(files) do
    body =
      Enum.reduce(files, <<>>, fn {name, content}, acc ->
        acc <> entry(name, content)
      end)

    # End-of-archive: two 512-byte zero blocks.
    body <> :binary.copy(<<0>>, 1024)
  end

  defp entry(name, content) do
    size = byte_size(content)
    name_padded = binary_pad(name, 100)
    size_str = Integer.to_string(size, 8) |> String.pad_leading(11, "0")

    # Build header fields then pad the whole thing to 512 bytes.
    # The checksum field (offset 148-155) is left as spaces (0x20) during
    # sum computation, then replaced with the real value.
    header_pre =
      name_padded <>
        "0006440\0" <>
        "0001750\0" <>
        "0001750\0" <>
        <<size_str::binary, 0>> <>
        "00000000000\0" <>
        "        " <>
        "0" <>
        binary_pad("", 100) <>
        "ustar  \0" <>
        binary_pad("", 32) <>
        binary_pad("", 32) <>
        "00000000000\0" <>
        "00000000000\0"

    header_pre = binary_pad(header_pre, 512)

    chksum =
      :binary.bin_to_list(header_pre)
      |> Enum.sum()
      |> Integer.to_string(8)
      |> String.pad_leading(6, "0")

    # Replace checksum placeholder at offset 148 (6 octal digits + NUL + space).
    header =
      binary_part(header_pre, 0, 148) <>
        chksum <> "\0 " <> binary_part(header_pre, 156, 512 - 156)

    pad_size = if rem(size, 512) == 0, do: 0, else: 512 - rem(size, 512)
    data_padded = content <> :binary.copy(<<0>>, pad_size)
    header <> data_padded
  end

  # Truncate to `target` bytes if too long, otherwise right-pad with NUL bytes.
  defp binary_pad(bin, target) when byte_size(bin) >= target,
    do: binary_part(bin, 0, target)

  defp binary_pad(bin, target),
    do: bin <> :binary.copy(<<0>>, target - byte_size(bin))
end
