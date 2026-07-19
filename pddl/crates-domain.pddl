(define (domain deliveroo-crates)
    (:requirements :strips :typing)

    (:types
        tile
        crate
    )

    (:predicates
        (at-agent ?position - tile)
        (crate-at ?box - crate ?position - tile)
        (crate-free ?position - tile)
        (adjacent ?from - tile ?to - tile)
        (push-line ?behind - tile ?crate-position - tile ?destination - tile)
        (crate-space ?position - tile)
    )

    (:action move
        :parameters (?from - tile ?to - tile)
        :precondition (and
            (at-agent ?from)
            (adjacent ?from ?to)
            (crate-free ?to)
        )
        :effect (and
            (not (at-agent ?from))
            (at-agent ?to)
        )
    )

    (:action push
        :parameters (
            ?box - crate
            ?behind - tile
            ?from - tile
            ?to - tile
        )
        :precondition (and
            (at-agent ?behind)
            (crate-at ?box ?from)
            (push-line ?behind ?from ?to)
            (crate-space ?from)
            (crate-space ?to)
            (crate-free ?to)
        )
        :effect (and
            (not (at-agent ?behind))
            (at-agent ?from)
            (not (crate-at ?box ?from))
            (crate-at ?box ?to)
            (crate-free ?from)
            (not (crate-free ?to))
        )
    )
)
