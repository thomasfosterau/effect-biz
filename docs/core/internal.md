# Internal subpath (not public API)

Helpers shared by the provider packages in this repository.

`@thomasfosterau/effect-biz/Payments.internal` holds helpers that the provider packages in this repository share (`shareLogin`, one in-flight token login shared by every waiting caller; the integer money core used to convert between minor units and major-unit decimals; the token cache and time-boxed request helpers of an OAuth-style login; the request helpers of a provider built over a generated operation client; and the response decoding, timestamp reading and HTTP error-status classification of a REST provider). It exists only because a provider may import nothing else of this workspace. It is **internal and exempt from semver**: its exports can change or disappear in any release, minor and patch included. Do not import it from application code.
