module Observable = ZenObservable
let operationTypeRe = %re(`/^\s*(query|mutation|subscription|\{)/`)
// let operationTypeRe =
//     Js.Re.(
//       Str.regexp(x),
//       text,
//       0,
//     )
let getOperationTypeFromMatched = matched => {
  let _matched = Js.String2.match_(matched, operationTypeRe)
  switch _matched {
  | Some(m) => m[0] == "{" ? "query" : matched
  | None => matched
  }
}

let getOperationType = operation => {
  let result = Js.String2.match_(operation, operationTypeRe)

  switch result {
  | Some(result) => getOperationTypeFromMatched(result[1])
  | None => Js.Exn.raiseError("Invalid operation:\n${operation}")
  }
}
type query
type variables
type operation = {query: option<query>, variables: option<variables>}
let requestToCompat = operation => {
  operation.variables->Belt.Option.isSome
    ? {query: operation.query, variables: operation.variables}
    : {query: operation.query, variables: None}
}
