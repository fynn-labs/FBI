defmodule FBI.Crypto do
  @moduledoc """
  AES-256-GCM encrypt/decrypt matching TS's `src/server/crypto.ts` byte layout.

  Layout of an encrypted blob: `nonce(12 bytes) || ciphertext || tag(16 bytes)`.
  This module produces and consumes blobs that round-trip bit-for-bit with TS,
  verified by a committed cross-language fixture in `test/fixtures/`.

  The key must be exactly 32 bytes (AES-256). In production it is read from
  the path in `:secrets_key_path` application env.
  """

  @nonce_len 12
  @tag_len 16

  @type key :: <<_::256>>

  @spec encrypt(key(), binary()) :: binary()
  def encrypt(key, plaintext) when byte_size(key) == 32 and is_binary(plaintext) do
    nonce = :crypto.strong_rand_bytes(@nonce_len)

    {ct, tag} =
      :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, plaintext, "", @tag_len, true)

    nonce <> ct <> tag
  end

  @spec decrypt(key(), binary()) :: {:ok, binary()} | {:error, :invalid}
  def decrypt(key, blob)
      when byte_size(key) == 32 and is_binary(blob) and byte_size(blob) >= @nonce_len + @tag_len do
    <<nonce::binary-size(@nonce_len), rest::binary>> = blob
    ct_size = byte_size(rest) - @tag_len
    <<ct::binary-size(ct_size), tag::binary-size(@tag_len)>> = rest

    case :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, ct, "", tag, false) do
      plaintext when is_binary(plaintext) -> {:ok, plaintext}
      :error -> {:error, :invalid}
    end
  end

  def decrypt(_key, _blob), do: {:error, :invalid}

  @spec load_key!(Path.t()) :: key()
  def load_key!(path) do
    key = File.read!(path)

    if byte_size(key) != 32 do
      raise "secrets key at #{inspect(path)} is #{byte_size(key)} bytes; expected 32"
    end

    key
  end
end
