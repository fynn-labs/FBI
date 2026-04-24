defmodule FBI.CryptoTest do
  use ExUnit.Case, async: true

  alias FBI.Crypto

  @fixture_dir Path.expand("../fixtures", __DIR__)

  defp load_hex!(name) do
    @fixture_dir
    |> Path.join(name)
    |> File.read!()
    |> String.trim()
    |> Base.decode16!(case: :lower)
  end

  describe "cross-language fixture" do
    test "decrypts TS-produced ciphertext" do
      key = load_hex!("crypto_key_32.hex")
      blob = load_hex!("crypto_ts_encrypted.hex")
      plaintext = @fixture_dir |> Path.join("crypto_plaintext.txt") |> File.read!()

      assert {:ok, ^plaintext} = Crypto.decrypt(key, blob)
    end

    test "Elixir-encrypted output is decryptable by the same logic (round trip)" do
      key = load_hex!("crypto_key_32.hex")
      plaintext = "round-trip test payload"
      blob = Crypto.encrypt(key, plaintext)
      assert {:ok, ^plaintext} = Crypto.decrypt(key, blob)
    end
  end

  describe "decrypt/2 negative paths" do
    test "rejects truncated blobs" do
      key = :crypto.strong_rand_bytes(32)
      assert {:error, :invalid} = Crypto.decrypt(key, <<1, 2, 3>>)
    end

    test "rejects bad tag" do
      key = :crypto.strong_rand_bytes(32)
      plaintext = "hi"
      blob = Crypto.encrypt(key, plaintext)
      <<head::binary-size(byte_size(blob) - 1), last>> = blob
      flipped = head <> <<Bitwise.bxor(last, 0x01)>>
      assert {:error, :invalid} = Crypto.decrypt(key, flipped)
    end
  end

  describe "load_key!/1" do
    test "raises when key length is wrong" do
      bad = Path.join(System.tmp_dir!(), "fbi-bad-key-#{System.unique_integer([:positive])}")
      File.write!(bad, <<0>>)
      on_exit(fn -> File.rm(bad) end)
      assert_raise RuntimeError, fn -> Crypto.load_key!(bad) end
    end
  end
end
