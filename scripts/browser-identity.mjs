// Permanent browser identities. Hydra's journal-extension client registers the
// redirect URIs derived from these, so changing either breaks pairing for every
// installed copy.

// PUBLIC half (base64 DER SubjectPublicKeyInfo) of the Chrome signing key. It
// fixes the extension ID; permanent from the first Chrome Web Store publish.
export const CHROME_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1LErhGn1fRVHGL1ClqbCjNFiVK72C4qRPPxqRu9oFKQXT5w8GKo93O6Xmnwn6VDApP3lezBCUHxcQfGruTcOuAkMRrFQyUs9EzNIzptpgdHRV8VahZ4AVT/Sie6CP3nFJBYX/TP7yafOEbbqVUXYt6RnwYR33cFDokDzgrifPszrfzy7PBtli8rF1DL2nVkjyGjfpysCBj313yB+lkKqWbcnOPBpJvVh0vD6OynVCwA+o5tQ93HVMOswc0CaOgtx66RhpUSHVOXUeUr6clHWguFnZ6dc0CIhhg2ItPOzkc9m6/nIfvCzMVdimEuEKdsTzWz35YeuHoXhDnppZ6kArwIDAQAB";

// Firefox add-on id; permanent from the first AMO publish.
export const GECKO_ID = "gubbi-extension@gubbi.ai";
