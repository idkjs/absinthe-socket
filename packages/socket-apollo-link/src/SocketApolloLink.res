type t
module Observable = {
  type t

  @bs.send external map: (t, Js.Json.t => Js.Json.t) => t = "map"
}

@bs.deriving(accessors)
type operation = {
  query: Js.Json.t,
  variables: Js.Json.t,
  operationName: string,
  extensions: Js.Json.t,
  setContext: Js.Json.t => Js.Json.t,
  getContext: unit => Js.Json.t,
  toKey: unit => string,
}

type requestHandler = (
  operation,
  operation => Observable.t,
) => option<Observable.t>

// @bs.new @bs.module("@apollo/client")
// external make: requestHandler => ApolloClient.Link.t = "ApolloLink"
@bs.new @bs.module("@apollo/client")
external make: requestHandler => t = "ApolloLink"
